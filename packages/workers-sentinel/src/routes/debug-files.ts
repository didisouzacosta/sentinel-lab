import { type Context, Hono } from 'hono';
import {
	chunkKey,
	type DebugFileKind,
	type DebugFileRecord,
	DIF_CHUNK_SIZE,
	DIF_CHUNKS_PER_REQUEST,
	DIF_MAX_REQUEST_BYTES,
	eventDebugImages,
	INLINE_ASSEMBLY_MAX_BYTES,
	MAX_DEBUG_FILE_BYTES,
	MAX_DEBUG_FILE_NAME,
	MAX_DIRECT_UPLOAD_BYTES,
	normalizeDebugId,
	proguardIdFromName,
	serializeSentryDebugFile,
} from '../lib/debug-files';
import { assembleDebugFile, projectStateCall, registerStoredFiles } from '../lib/dif-assembly';
import { ingestDebugFile } from '../lib/dif-ingest';
import { canManageProject, getProjectWithAccess } from '../lib/project-access';
import type { AuthContext, Env, Project } from '../types';

/**
 * Debug files (dSYM, ProGuard/R8 mappings).
 *
 * - `debugFileRoutes` (mounted at `/api/projects`): the dashboard/MCP API.
 * - `debugFileCompatRoutes` (mounted at `/api/0`, before the Sentry-shaped
 *   API): the same operations for CI (the `/api/0/*` path is reachable
 *   without a Cloudflare Access login), plus the sentry-cli protocol: chunk
 *   upload, DIF assembly and the DIF list.
 */

type Variables = { auth?: AuthContext };
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type Access = { project: Project; memberRole: string };

function bucketOf(c: AppContext): R2Bucket | Response {
	const bucket = c.env.DEBUG_FILES;
	if (!bucket) {
		return c.json(
			{
				error: 'debug_files_unconfigured',
				message: 'This Sentinel has no DEBUG_FILES bucket bound; debug files are disabled',
			},
			503,
		);
	}
	return bucket;
}

/** Project for `/api/0/projects/{org}/{project}/…`: slug first, then id; members only. */
async function compatAccess(c: AppContext, projectParam: string): Promise<Access | Response> {
	const auth = c.get('auth');
	if (!auth) return c.json({ error: 'unauthorized' }, 401);
	const authState = c.env.AUTH_STATE.get(c.env.AUTH_STATE.idFromName('global'));
	const response = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: projectParam, userId: auth.user.id, alsoTryId: true }),
		}),
	);
	if (!response.ok) return c.json({ error: 'not_found', message: 'project not found' }, 404);
	return (await response.json()) as Access;
}

function errorJson(c: AppContext, status: number, error: string, message: string): Response {
	return c.json({ error, message }, status as 400);
}

// ---------------------------------------------------------------------------
// Shared handlers
// ---------------------------------------------------------------------------

async function handleList(c: AppContext, access: Access): Promise<Response> {
	const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
	const { status, data } = await projectStateCall(c.env, access.project.id, '/debug-files/list', {
		kind: c.req.query('kind'),
		debugId: c.req.query('debugId') ?? c.req.query('debug_id'),
		cursor: c.req.query('cursor'),
		limit: Number.isFinite(limit) ? limit : undefined,
	});
	return c.json(data as object, status as 200);
}

function counted(
	body: ReadableStream<Uint8Array>,
	max: number,
	onOver: () => void,
): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.length;
				if (seen > max) {
					onOver();
					controller.error(new Error('too_large'));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		yield value;
	}
}

/**
 * Direct upload: the request body is the file (dSYM object, universal dSYM
 * or mapping.txt), optionally `Content-Encoding: gzip`. Query: `name`,
 * `kind` (`dsym` | `proguard`), `debugId` (ProGuard UUID).
 */
async function handleUpload(c: AppContext, access: Access): Promise<Response> {
	const bucket = bucketOf(c);
	if (bucket instanceof Response) return bucket;
	const body = c.req.raw.body;
	if (!body) return errorJson(c, 400, 'empty_file', 'Send the file as the request body');
	const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
	if (Number.isFinite(declared) && declared > MAX_DIRECT_UPLOAD_BYTES) {
		return errorJson(
			c,
			413,
			'too_large',
			`Direct uploads are limited to ${MAX_DIRECT_UPLOAD_BYTES} bytes; use sentry-cli (chunked upload) for bigger files`,
		);
	}
	const kindParam = c.req.query('kind');
	if (kindParam && kindParam !== 'dsym' && kindParam !== 'proguard') {
		return errorJson(c, 400, 'invalid_kind', 'kind must be "dsym" or "proguard"');
	}
	const rawName = (c.req.query('name') ?? '').trim();
	const name = (rawName || (kindParam === 'proguard' ? 'mapping.txt' : 'upload')).slice(
		0,
		MAX_DEBUG_FILE_NAME,
	);
	const debugId = c.req.query('debugId') ?? c.req.query('uuid') ?? null;
	if (debugId && !normalizeDebugId(debugId)) {
		return errorJson(c, 400, 'invalid_debug_id', 'debugId must be a UUID');
	}

	const usage = await projectStateCall<{ bytes: number; quotaBytes: number }>(
		c.env,
		access.project.id,
		'/debug-files/usage',
		{},
	);
	if (usage.data.bytes >= usage.data.quotaBytes) {
		return errorJson(
			c,
			413,
			'debug_file_quota',
			`Debug file storage for this project is full (${usage.data.quotaBytes} bytes); delete old files first`,
		);
	}

	let overWire = false;
	let stream = counted(body, MAX_DIRECT_UPLOAD_BYTES, () => {
		overWire = true;
	});
	const encoding = (c.req.header('Content-Encoding') ?? '').trim().toLowerCase();
	if (encoding === 'gzip') {
		stream = stream.pipeThrough(new DecompressionStream('gzip'));
	} else if (encoding && encoding !== 'identity') {
		return errorJson(c, 400, 'unsupported_encoding', 'Only gzip Content-Encoding is supported');
	}

	let result: Awaited<ReturnType<typeof ingestDebugFile>>;
	try {
		result = await ingestDebugFile(bucket, iterate(stream), {
			projectId: access.project.id,
			name,
			kind: (kindParam as 'dsym' | 'proguard' | undefined) ?? null,
			debugId,
			maxBytes: MAX_DEBUG_FILE_BYTES,
		});
	} catch (error) {
		if (overWire) {
			return errorJson(
				c,
				413,
				'too_large',
				`Direct uploads are limited to ${MAX_DIRECT_UPLOAD_BYTES} bytes`,
			);
		}
		if (error instanceof TypeError && encoding === 'gzip') {
			return errorJson(c, 400, 'invalid_gzip', 'The gzip body could not be decompressed');
		}
		console.error(
			'Debug file upload failed:',
			error instanceof Error ? error.message.slice(0, 120) : 'unknown',
		);
		return c.json(
			{ error: 'debug_file_storage_failed', message: 'Storage failed; try again' },
			503,
			{
				'Retry-After': '5',
			},
		);
	}
	if (!result.ok) return errorJson(c, result.status, result.error, result.message);
	const registered = await registerStoredFiles(c.env, bucket, access.project.id, result.files);
	if (!registered.ok) return errorJson(c, registered.status, registered.error, registered.message);
	return c.json({ debugFiles: registered.files }, 201);
}

async function handleGet(c: AppContext, access: Access, id: string): Promise<Response> {
	const { status, data } = await projectStateCall<{ debugFile?: DebugFileRecord }>(
		c.env,
		access.project.id,
		'/debug-files/get',
		{ id },
	);
	if (status !== 200) return c.json(data as object, status as 404);
	return c.json({ debugFile: data.debugFile });
}

async function handleDelete(c: AppContext, access: Access, id: string): Promise<Response> {
	if (!canManageProject(access.memberRole)) {
		return errorJson(c, 403, 'forbidden', 'Only project owners and admins can delete debug files');
	}
	const bucket = bucketOf(c);
	if (bucket instanceof Response) return bucket;
	const { status, data } = await projectStateCall<{ debugFile?: DebugFileRecord; r2Key?: string }>(
		c.env,
		access.project.id,
		'/debug-files/delete',
		{ id },
	);
	if (status !== 200) return c.json(data as object, status as 404);
	if (data.r2Key) await bucket.delete(data.r2Key);
	return c.json({ deleted: data.debugFile });
}

interface CheckImage {
	debugId: string;
	kind: DebugFileKind | null;
	codeFile: string | null;
	arch: string | null;
	status: 'found' | 'missing' | 'processing';
	debugFile: DebugFileRecord | null;
}

/**
 * Which debug files an event (or issue's latest event, or a list of ids)
 * needs, and whether each is stored. What CI and agents call after an
 * upload, and what the issue page shows.
 */
async function handleCheck(c: AppContext, access: Access): Promise<Response> {
	let body: { debugIds?: unknown; eventId?: unknown; issueId?: unknown };
	try {
		body = (await c.req.json()) as typeof body;
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
	} catch {
		return errorJson(c, 400, 'invalid_json', 'Send {debugIds} or {eventId} or {issueId}');
	}
	let images: Array<{
		debugId: string;
		kind: DebugFileKind | null;
		codeFile: string | null;
		arch: string | null;
	}> = [];
	let eventId: string | null = null;
	if (Array.isArray(body.debugIds)) {
		for (const raw of body.debugIds.slice(0, 200)) {
			const debugId = normalizeDebugId(raw);
			if (debugId) images.push({ debugId, kind: null, codeFile: null, arch: null });
		}
	} else if (typeof body.eventId === 'string' || typeof body.issueId === 'string') {
		let event: unknown = null;
		if (typeof body.eventId === 'string') {
			const { status, data } = await projectStateCall<{ event?: unknown }>(
				c.env,
				access.project.id,
				'/event',
				{
					eventId: body.eventId.replace(/-/g, '').toLowerCase(),
				},
			);
			if (status !== 200) return errorJson(c, 404, 'event_not_found', 'Event not found');
			event = data.event;
		} else {
			const { data } = await projectStateCall<{ events?: unknown[] }>(
				c.env,
				access.project.id,
				'/issue/events',
				{
					issueId: String(body.issueId).toLowerCase(),
					limit: 1,
				},
			);
			event = data.events?.[0] ?? null;
			if (!event) return errorJson(c, 404, 'issue_not_found', 'Issue not found or has no events');
		}
		eventId = ((event as { event_id?: string }).event_id as string | undefined) ?? null;
		images = eventDebugImages(event);
	} else {
		return errorJson(c, 400, 'invalid_request', 'Send {debugIds} or {eventId} or {issueId}');
	}

	const { data } = await projectStateCall<{ found: DebugFileRecord[]; processing: string[] }>(
		c.env,
		access.project.id,
		'/debug-files/lookup',
		{ debugIds: images.map((image) => image.debugId) },
	);
	const result: CheckImage[] = images.map((image) => {
		const match = data.found.find(
			(file) => file.debugId === image.debugId && (image.kind === null || file.kind === image.kind),
		);
		return {
			...image,
			kind: image.kind ?? match?.kind ?? null,
			status: match ? 'found' : data.processing.includes(image.debugId) ? 'processing' : 'missing',
			debugFile: match ?? null,
		};
	});
	return c.json({
		...(eventId ? { eventId } : {}),
		images: result,
		found: result.filter((image) => image.status === 'found').length,
		missing: result.filter((image) => image.status === 'missing').length,
		processing: result.filter((image) => image.status === 'processing').length,
	});
}

// ---------------------------------------------------------------------------
// Native routes (/api/projects/:slug/debug-files)
// ---------------------------------------------------------------------------

export const debugFileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function nativeAccess(c: AppContext): Promise<Access | Response> {
	return getProjectWithAccess(c, c.req.param('slug') as string);
}

debugFileRoutes.get('/:slug/debug-files', async (c) => {
	const access = await nativeAccess(c);
	return access instanceof Response ? access : handleList(c, access);
});
debugFileRoutes.post('/:slug/debug-files', async (c) => {
	const access = await nativeAccess(c);
	return access instanceof Response ? access : handleUpload(c, access);
});
debugFileRoutes.post('/:slug/debug-files/check', async (c) => {
	const access = await nativeAccess(c);
	return access instanceof Response ? access : handleCheck(c, access);
});
debugFileRoutes.get('/:slug/debug-files/:id', async (c) => {
	const access = await nativeAccess(c);
	return access instanceof Response ? access : handleGet(c, access, c.req.param('id'));
});
debugFileRoutes.delete('/:slug/debug-files/:id', async (c) => {
	const access = await nativeAccess(c);
	return access instanceof Response ? access : handleDelete(c, access, c.req.param('id'));
});

// ---------------------------------------------------------------------------
// /api/0: CI mirror + sentry-cli protocol
// ---------------------------------------------------------------------------

export const debugFileCompatRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Register a handler with and without the trailing slash Sentry clients use. */
function compat(
	method: 'get' | 'post' | 'delete',
	path: string,
	handler: (c: AppContext) => Promise<Response> | Response,
) {
	debugFileCompatRoutes[method](path, handler);
	debugFileCompatRoutes[method](`${path}/`, handler);
}

function withCompatProject(handler: (c: AppContext, access: Access) => Promise<Response>) {
	return async (c: AppContext) => {
		const access = await compatAccess(c, c.req.param('project') as string);
		return access instanceof Response ? access : handler(c, access);
	};
}

const PROJECT = '/projects/:org/:project';

compat('get', `${PROJECT}/debug-files`, withCompatProject(handleList));
compat('post', `${PROJECT}/debug-files`, withCompatProject(handleUpload));
compat('post', `${PROJECT}/debug-files/check`, withCompatProject(handleCheck));
compat(
	'get',
	`${PROJECT}/debug-files/:id`,
	withCompatProject((c, access) => handleGet(c, access, c.req.param('id') as string)),
);
compat(
	'delete',
	`${PROJECT}/debug-files/:id`,
	withCompatProject((c, access) => handleDelete(c, access, c.req.param('id') as string)),
);

/** API root: `sentry-cli info` reads it to show the authenticated identity. */
export const apiRoot = (c: AppContext) => {
	const auth = c.get('auth');
	return c.json({
		version: '0',
		auth: auth ? { scopes: auth.apiToken?.scopes ?? ['read', 'write'] } : null,
		user: auth ? { id: auth.user.id, name: auth.user.name, email: auth.user.email } : null,
	});
};

/** Chunk upload options: sentry-cli asks before every debug-file upload. */
compat('get', '/organizations/:org/chunk-upload', (c) => {
	if (!c.env.DEBUG_FILES) return bucketOf(c) as Response;
	// Relative to the API root, like Sentry without an upload-url prefix:
	// sentry-cli joins it with its own base URL, so the request's host
	// (rewritten under `wrangler dev`, or an internal name behind a proxy)
	// never decides where the chunks go.
	return c.json({
		url: `organizations/${encodeURIComponent(c.req.param('org') as string)}/chunk-upload/`,
		chunkSize: DIF_CHUNK_SIZE,
		chunksPerRequest: DIF_CHUNKS_PER_REQUEST,
		maxFileSize: MAX_DEBUG_FILE_BYTES,
		maxRequestSize: DIF_MAX_REQUEST_BYTES,
		concurrency: 4,
		hashAlgorithm: 'sha1',
		compression: ['gzip'],
		accept: ['debug_files', 'proguard'],
	});
});

async function sha1Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Chunk upload: multipart parts named `file` (raw) or `file_gzip`, each part's
 * filename being the SHA-1 of its uncompressed bytes. Chunks are content
 * addressed and project-independent (like Sentry's), checked against their
 * name, and expire after a day.
 */
compat('post', '/organizations/:org/chunk-upload', async (c) => {
	const bucket = bucketOf(c);
	if (bucket instanceof Response) return bucket;
	const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
	if (Number.isFinite(declared) && declared > DIF_MAX_REQUEST_BYTES + 1024 * 1024) {
		return errorJson(
			c,
			413,
			'too_large',
			`Chunk requests are limited to ${DIF_MAX_REQUEST_BYTES} bytes`,
		);
	}
	let form: FormData;
	try {
		form = await c.req.raw.formData();
	} catch {
		return errorJson(c, 400, 'invalid_multipart', 'Expected multipart/form-data chunks');
	}
	const parts: Array<{ field: string; file: File }> = [];
	for (const field of ['file', 'file_gzip']) {
		for (const value of form.getAll(field)) {
			if (typeof value !== 'string') parts.push({ field, file: value as File });
		}
	}
	if (parts.length > DIF_CHUNKS_PER_REQUEST) {
		return errorJson(
			c,
			400,
			'too_many_chunks',
			`At most ${DIF_CHUNKS_PER_REQUEST} chunks per request`,
		);
	}
	for (const { field, file } of parts) {
		const checksum = file.name.toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(checksum)) {
			return errorJson(c, 400, 'invalid_chunk_name', 'Chunk names must be their SHA-1');
		}
		let bytes = new Uint8Array(await file.arrayBuffer());
		if (field === 'file_gzip') {
			try {
				bytes = new Uint8Array(
					await new Response(
						new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
					).arrayBuffer(),
				);
			} catch {
				return errorJson(c, 400, 'invalid_gzip', `Chunk ${checksum} is not valid gzip`);
			}
		}
		if (bytes.length > DIF_CHUNK_SIZE) {
			return errorJson(c, 400, 'chunk_too_large', `Chunks are limited to ${DIF_CHUNK_SIZE} bytes`);
		}
		if ((await sha1Hex(bytes)) !== checksum) {
			return errorJson(c, 400, 'checksum_mismatch', `Chunk ${checksum} does not match its SHA-1`);
		}
		await bucket.put(chunkKey(checksum), bytes);
	}
	return c.json({});
});

/** An assembly as ProjectState reports it (durable-objects/debug-files-state.ts). */
interface AssemblyView {
	checksum: string;
	state: string;
	detail: string | null;
	name: string | null;
	debugId: string | null;
	files: DebugFileRecord[];
}

/**
 * The `dif` sentry-cli prints for a finished assembly: the stored file, or
 * for an acknowledged app binary (stored nothing) a description of it.
 */
function assemblyDif(row: AssemblyView, checksum: string): { dif?: Record<string, unknown> } {
	if (row.state !== 'ok') return {};
	if (row.files[0]) return { dif: serializeSentryDebugFile(row.files[0]) };
	if (!row.debugId) return {};
	return {
		dif: {
			id: checksum,
			uuid: row.debugId,
			debugId: row.debugId,
			codeId: null,
			cpuName: 'any',
			objectName: row.name ?? 'executable',
			symbolType: 'macho',
			headers: {},
			size: 0,
			sha1: checksum,
			dateCreated: new Date().toISOString(),
			data: { type: 'exe', features: ['symtab'] },
		},
	};
}

interface AssembleFile {
	name?: unknown;
	debug_id?: unknown;
	chunks?: unknown;
}

/**
 * DIF assembly: for each declared file (keyed by its SHA-1) report missing
 * chunks, or assemble it — inline when small, on the queue when large — and
 * report `created`/`assembling`/`ok`/`error` on later polls.
 */
compat(
	'post',
	`${PROJECT}/files/difs/assemble`,
	withCompatProject(async (c, access) => {
		const bucket = bucketOf(c);
		if (bucket instanceof Response) return bucket;
		let body: Record<string, AssembleFile>;
		try {
			body = (await c.req.json()) as Record<string, AssembleFile>;
			if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
		} catch {
			return errorJson(c, 400, 'invalid_json', 'Expected {checksum: {name, chunks}}');
		}
		const entries = Object.entries(body).slice(0, 200);
		const { data: known } = await projectStateCall<{ assemblies: AssemblyView[] }>(
			c.env,
			access.project.id,
			'/dif-assembly/get',
			{
				checksums: entries.map(([checksum]) => checksum.toLowerCase()),
				proguardIds: Object.fromEntries(
					entries.map(([checksum, file]) => [
						checksum.toLowerCase(),
						proguardIdFromName(typeof file?.name === 'string' ? file.name : null),
					]),
				),
			},
		);

		const out: Record<string, unknown> = {};
		for (const [rawChecksum, file] of entries) {
			const checksum = rawChecksum.toLowerCase();
			const chunks = Array.isArray(file?.chunks)
				? file.chunks
						.filter((chunk): chunk is string => typeof chunk === 'string')
						.map((x) => x.toLowerCase())
				: [];
			const name = (typeof file?.name === 'string' ? file.name : 'upload').slice(
				0,
				MAX_DEBUG_FILE_NAME,
			);
			const debugId = normalizeDebugId(file?.debug_id);
			const proguardId = proguardIdFromName(name);
			const row = known.assemblies.find((assembly) => assembly.checksum === checksum);
			// The same mapping content under another UUID is a new file.
			const sameFile =
				!proguardId || row?.state !== 'ok' || row.files.some((f) => f.debugId === proguardId);
			if (row && row.state !== 'error' && sameFile) {
				out[rawChecksum] = {
					state: row.state,
					missingChunks: [],
					detail: row.detail,
					...assemblyDif(row, checksum),
				};
				continue;
			}
			if (!/^[0-9a-f]{40}$/.test(checksum) || chunks.length === 0) {
				out[rawChecksum] = {
					state: 'error',
					missingChunks: [],
					detail: 'invalid checksum or no chunks',
				};
				continue;
			}
			const heads = await Promise.all(chunks.map((chunk) => bucket.head(chunkKey(chunk))));
			const missing = chunks.filter((_, index) => !heads[index]);
			if (missing.length > 0) {
				out[rawChecksum] = { state: 'not_found', missingChunks: [...new Set(missing)] };
				continue;
			}
			const total = heads.reduce((sum, head) => sum + (head?.size ?? 0), 0);
			if (total > MAX_DEBUG_FILE_BYTES) {
				out[rawChecksum] = { state: 'error', missingChunks: [], detail: 'file too large' };
				continue;
			}
			const job = { projectId: access.project.id, checksum, name, debugId, chunks };
			await projectStateCall(c.env, access.project.id, '/dif-assembly/set', {
				checksum,
				state: 'created',
				name,
				debugId,
			});
			if (c.env.PROCESS_QUEUE && total > INLINE_ASSEMBLY_MAX_BYTES) {
				await c.env.PROCESS_QUEUE.send({ type: 'dif.assemble', ...job });
				out[rawChecksum] = { state: 'created', missingChunks: [] };
				continue;
			}
			try {
				await assembleDebugFile(c.env, bucket, job);
			} catch (error) {
				console.error(
					'Assembly failed:',
					error instanceof Error ? error.message.slice(0, 120) : 'unknown',
				);
				await projectStateCall(c.env, access.project.id, '/dif-assembly/set', {
					checksum,
					state: 'error',
					detail: 'storage failed; upload again',
				});
			}
			const { data: after } = await projectStateCall<{ assemblies: AssemblyView[] }>(
				c.env,
				access.project.id,
				'/dif-assembly/get',
				{ checksums: [checksum] },
			);
			const done = after.assemblies[0];
			out[rawChecksum] = {
				state: done?.state ?? 'error',
				missingChunks: [],
				detail: done?.detail ?? null,
				...(done ? assemblyDif(done, checksum) : {}),
			};
		}
		return c.json(out);
	}),
);

/** Sentry's DIF list (`sentry-cli debug-files` lookups, other Sentry tooling). */
compat(
	'get',
	`${PROJECT}/files/dsyms`,
	withCompatProject(async (c, access) => {
		const debugId = c.req.query('debug_id') ?? c.req.query('query') ?? undefined;
		const { data } = await projectStateCall<{ debugFiles: DebugFileRecord[] }>(
			c.env,
			access.project.id,
			'/debug-files/list',
			{ debugId: debugId && normalizeDebugId(debugId) ? debugId : undefined, limit: 100 },
		);
		return c.json(data.debugFiles.map(serializeSentryDebugFile));
	}),
);

compat(
	'delete',
	`${PROJECT}/files/dsyms`,
	withCompatProject(async (c, access) => {
		const id = c.req.query('id');
		if (!id) return errorJson(c, 400, 'invalid_request', 'Pass ?id=');
		const response = await handleDelete(c, access, id);
		return response.ok ? c.body(null, 204) : response;
	}),
);
