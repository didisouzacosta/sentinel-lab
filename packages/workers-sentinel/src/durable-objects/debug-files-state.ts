import type { DebugFileKind, DebugFileRecord } from '../lib/debug-files';
import { DEFAULT_PROJECT_DEBUG_FILE_BYTES, normalizeDebugId } from '../lib/debug-files';
import type { StoredDebugFile } from '../lib/dif-ingest';

/**
 * Debug-file metadata inside ProjectState: one row per (debug id, kind),
 * pointing at its R2 object, plus the state of sentry-cli chunk assemblies.
 * Bytes never live here. Kept out of project-state.ts so the internal
 * surface stays readable; ProjectState dispatches `/debug-files/*` and
 * `/dif-assembly/*` to `handleDebugFilesRequest`.
 */

export const DEBUG_FILES_MIGRATIONS = [
	`CREATE TABLE IF NOT EXISTS debug_files (
  id TEXT PRIMARY KEY,
  debug_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  arch TEXT,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha1 TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(debug_id, kind)
);`,
	'CREATE INDEX IF NOT EXISTS idx_debug_files_created ON debug_files(created_at, id);',
	'CREATE INDEX IF NOT EXISTS idx_debug_files_sha1 ON debug_files(sha1);',
	`CREATE TABLE IF NOT EXISTS dif_assemblies (
  checksum TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  detail TEXT,
  name TEXT,
  debug_id TEXT,
  file_ids TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
];

/** Assemblies stuck longer than this are reported as errors (the job died). */
const ASSEMBLY_STALE_MS = 30 * 60 * 1000;

export type AssemblyState = 'created' | 'assembling' | 'ok' | 'error';

export interface AssemblyRow {
	checksum: string;
	state: AssemblyState;
	detail: string | null;
	name: string | null;
	debugId: string | null;
	files: DebugFileRecord[];
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function toRecord(row: Record<string, SqlStorageValue>): DebugFileRecord {
	return {
		id: String(row.id),
		debugId: String(row.debug_id),
		kind: row.kind as DebugFileKind,
		arch: row.arch == null ? null : String(row.arch),
		name: String(row.name),
		size: Number(row.size),
		sha1: row.sha1 == null ? null : String(row.sha1),
		createdAt: String(row.created_at),
	};
}

function usage(sql: SqlStorage): { bytes: number; count: number } {
	const row = sql
		.exec('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM debug_files')
		.one();
	return { bytes: Number(row.bytes), count: Number(row.count) };
}

function recordsById(sql: SqlStorage, ids: string[]): DebugFileRecord[] {
	const out: DebugFileRecord[] = [];
	for (const id of ids) {
		const rows = sql.exec('SELECT * FROM debug_files WHERE id = ?', id).toArray();
		if (rows.length > 0) out.push(toRecord(rows[0]));
	}
	return out;
}

/**
 * Register stored objects. Re-uploading a debug id replaces its row (the R2
 * key is deterministic, so the bytes were already replaced). The quota is
 * checked against the final state; on refusal the caller deletes the keys
 * listed in `orphanKeys` (objects that no surviving row points to).
 */
function register(
	sql: SqlStorage,
	body: { files?: StoredDebugFile[]; quotaBytes?: number },
): Response {
	const files = Array.isArray(body.files) ? body.files : [];
	const quota =
		typeof body.quotaBytes === 'number' ? body.quotaBytes : DEFAULT_PROJECT_DEBUG_FILE_BYTES;
	const { bytes } = usage(sql);
	let replaced = 0;
	const fresh: string[] = [];
	for (const file of files) {
		const existing = sql
			.exec('SELECT size FROM debug_files WHERE debug_id = ? AND kind = ?', file.debugId, file.kind)
			.toArray();
		if (existing.length > 0) replaced += Number(existing[0].size);
		else fresh.push(file.r2Key);
	}
	const incoming = files.reduce((sum, file) => sum + file.size, 0);
	if (bytes - replaced + incoming > quota) {
		return json(
			{
				error: 'debug_file_quota',
				message: `Debug file storage for this project is limited to ${quota} bytes`,
				orphanKeys: fresh,
			},
			413,
		);
	}
	const now = new Date().toISOString();
	// Synchronous with no await in between, so the rows commit together.
	const ids: string[] = [];
	for (const file of files) {
		const id = crypto.randomUUID();
		sql.exec(
			`INSERT INTO debug_files (id, debug_id, kind, arch, name, size, sha1, r2_key, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (debug_id, kind) DO UPDATE SET
			   id = excluded.id, arch = excluded.arch, name = excluded.name, size = excluded.size,
			   sha1 = excluded.sha1, r2_key = excluded.r2_key, created_at = excluded.created_at`,
			id,
			file.debugId,
			file.kind,
			file.arch,
			file.name.slice(0, 200),
			file.size,
			file.sha1,
			file.r2Key,
			now,
		);
		ids.push(id);
	}
	return json({ files: recordsById(sql, ids) });
}

function list(
	sql: SqlStorage,
	body: { kind?: string; debugId?: string; limit?: number; cursor?: string },
): Response {
	const limit = Math.min(Math.max(Number.isFinite(body.limit) ? Number(body.limit) : 25, 1), 100);
	const where: string[] = [];
	const args: SqlStorageValue[] = [];
	if (body.kind === 'macho' || body.kind === 'proguard') {
		where.push('kind = ?');
		args.push(body.kind);
	}
	if (body.debugId) {
		const debugId = normalizeDebugId(body.debugId);
		if (!debugId) return json({ debugFiles: [], hasMore: false });
		where.push('debug_id = ?');
		args.push(debugId);
	}
	if (body.cursor) {
		const separator = body.cursor.lastIndexOf('|');
		if (separator > 0) {
			where.push('(created_at < ? OR (created_at = ? AND id < ?))');
			const createdAt = body.cursor.slice(0, separator);
			args.push(createdAt, createdAt, body.cursor.slice(separator + 1));
		}
	}
	const rows = sql
		.exec(
			`SELECT * FROM debug_files ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			...args,
			limit + 1,
		)
		.toArray();
	const page = rows.slice(0, limit).map(toRecord);
	const hasMore = rows.length > limit;
	const last = page[page.length - 1];
	return json({
		debugFiles: page,
		hasMore,
		...(hasMore && last ? { nextCursor: `${last.createdAt}|${last.id}` } : {}),
		usage: { ...usage(sql), quotaBytes: DEFAULT_PROJECT_DEBUG_FILE_BYTES },
	});
}

function lookup(sql: SqlStorage, body: { debugIds?: unknown }): Response {
	const ids = Array.isArray(body.debugIds) ? body.debugIds.slice(0, 200) : [];
	const found: DebugFileRecord[] = [];
	const processing: string[] = [];
	const cutoff = new Date(Date.now() - ASSEMBLY_STALE_MS).toISOString();
	for (const raw of ids) {
		const debugId = normalizeDebugId(raw);
		if (!debugId) continue;
		const rows = sql.exec('SELECT * FROM debug_files WHERE debug_id = ?', debugId).toArray();
		if (rows.length > 0) {
			found.push(...rows.map(toRecord));
			continue;
		}
		const pending = sql
			.exec(
				"SELECT 1 FROM dif_assemblies WHERE debug_id = ? AND state IN ('created', 'assembling') AND updated_at > ?",
				debugId,
				cutoff,
			)
			.toArray();
		if (pending.length > 0) processing.push(debugId);
	}
	return json({ found, processing });
}

function getAssemblies(
	sql: SqlStorage,
	body: { checksums?: unknown; proguardIds?: Record<string, string | null> },
): Response {
	const checksums = Array.isArray(body.checksums) ? body.checksums.slice(0, 1000) : [];
	const proguardIds =
		body.proguardIds && typeof body.proguardIds === 'object' ? body.proguardIds : {};
	const cutoff = new Date(Date.now() - ASSEMBLY_STALE_MS).toISOString();
	const assemblies: AssemblyRow[] = [];
	for (const checksum of checksums) {
		if (typeof checksum !== 'string') continue;
		const rows = sql.exec('SELECT * FROM dif_assemblies WHERE checksum = ?', checksum).toArray();
		if (rows.length > 0) {
			const row = rows[0];
			let state = row.state as AssemblyState;
			let detail = row.detail == null ? null : String(row.detail);
			if ((state === 'created' || state === 'assembling') && String(row.updated_at) < cutoff) {
				state = 'error';
				detail = 'assembly did not finish; upload again';
			}
			const fileIds = row.file_ids ? (JSON.parse(String(row.file_ids)) as string[]) : [];
			assemblies.push({
				checksum,
				state,
				detail,
				name: row.name == null ? null : String(row.name),
				debugId: row.debug_id == null ? null : String(row.debug_id),
				files: recordsById(sql, fileIds),
			});
			continue;
		}
		// Already stored under this exact content: nothing to assemble. A
		// Mach-O's UUID is part of its bytes, so the same SHA-1 is the same
		// file; a ProGuard mapping's UUID is not (builds with an unchanged
		// mapping get new UUIDs), so it must match too.
		const proguardId = proguardIds[checksum];
		const stored = (
			proguardId
				? sql.exec(
						"SELECT * FROM debug_files WHERE sha1 = ? AND kind = 'proguard' AND debug_id = ?",
						checksum,
						proguardId,
					)
				: sql.exec("SELECT * FROM debug_files WHERE sha1 = ? AND kind = 'macho'", checksum)
		).toArray();
		if (stored.length > 0) {
			assemblies.push({
				checksum,
				state: 'ok',
				detail: null,
				name: null,
				debugId: null,
				files: stored.map(toRecord),
			});
		}
	}
	return json({ assemblies });
}

function setAssembly(
	sql: SqlStorage,
	body: {
		checksum?: string;
		state?: AssemblyState;
		detail?: string | null;
		name?: string | null;
		debugId?: string | null;
		fileIds?: string[];
	},
): Response {
	if (!body.checksum || !body.state) return json({ error: 'invalid_request' }, 400);
	const now = new Date().toISOString();
	sql.exec(
		`INSERT INTO dif_assemblies (checksum, state, detail, name, debug_id, file_ids, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (checksum) DO UPDATE SET
		   state = excluded.state, detail = excluded.detail,
		   name = COALESCE(excluded.name, dif_assemblies.name),
		   debug_id = COALESCE(excluded.debug_id, dif_assemblies.debug_id),
		   file_ids = COALESCE(excluded.file_ids, dif_assemblies.file_ids),
		   updated_at = excluded.updated_at`,
		body.checksum,
		body.state,
		body.detail ?? null,
		body.name ?? null,
		body.debugId ? normalizeDebugId(body.debugId) : null,
		body.fileIds ? JSON.stringify(body.fileIds) : null,
		now,
		now,
	);
	// Finished assemblies older than a day are only history.
	sql.exec(
		"DELETE FROM dif_assemblies WHERE state IN ('ok', 'error') AND updated_at < ?",
		new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
	);
	return json({ ok: true });
}

export function handleDebugFilesRequest(
	sql: SqlStorage,
	path: string,
	body: Record<string, unknown>,
): Response | null {
	switch (path) {
		case '/debug-files/register':
			return register(sql, body as { files?: StoredDebugFile[]; quotaBytes?: number });
		case '/debug-files/list':
			return list(
				sql,
				body as { kind?: string; debugId?: string; limit?: number; cursor?: string },
			);
		case '/debug-files/get': {
			const rows = sql
				.exec('SELECT * FROM debug_files WHERE id = ?', String(body.id ?? ''))
				.toArray();
			if (rows.length === 0) return json({ error: 'debug_file_not_found' }, 404);
			return json({ debugFile: toRecord(rows[0]), r2Key: String(rows[0].r2_key) });
		}
		case '/debug-files/delete': {
			const rows = sql
				.exec('SELECT * FROM debug_files WHERE id = ?', String(body.id ?? ''))
				.toArray();
			if (rows.length === 0) return json({ error: 'debug_file_not_found' }, 404);
			sql.exec('DELETE FROM debug_files WHERE id = ?', String(body.id));
			return json({ debugFile: toRecord(rows[0]), r2Key: String(rows[0].r2_key) });
		}
		case '/debug-files/lookup':
			return lookup(sql, body);
		case '/debug-files/usage':
			return json({ ...usage(sql), quotaBytes: DEFAULT_PROJECT_DEBUG_FILE_BYTES });
		case '/dif-assembly/get':
			return getAssemblies(
				sql,
				body as { checksums?: unknown; proguardIds?: Record<string, string | null> },
			);
		case '/dif-assembly/set':
			return setAssembly(sql, body);
		default:
			return null;
	}
}
