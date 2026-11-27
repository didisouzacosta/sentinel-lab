import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Debug files (dSYM objects and ProGuard/R8 mappings): storage contract,
 * identifiers and limits. Everything lives in the `DEBUG_FILES` R2 bucket:
 *
 * - `p/{projectId}/dif/{id[0:2]}/{id[2:]}/debuginfo|proguard` — one object
 *   per debug id, in the "unified" layout symbol servers (Symbolicator)
 *   read, `id` being the debug id as 32 lowercase hex digits. The project
 *   prefix keeps projects apart and lets a project purge sweep them.
 * - `chunks/{sha1}` — content-addressed upload chunks (sentry-cli chunk
 *   upload), removed by a 1-day lifecycle rule once assembled or abandoned.
 * - `staging/{projectId}/{nonce}` — a whole upload waiting to be split
 *   (universal Mach-O) or renamed (ProGuard mapping without a given UUID).
 */

export type DebugFileKind = 'macho' | 'proguard';

/** Largest single debug file accepted (assembled from chunks). */
export const MAX_DEBUG_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Largest request body for a direct upload. Cloudflare rejects bodies over
 * 100 MB on most plans before the worker runs; bigger files go through the
 * chunked sentry-cli protocol.
 */
export const MAX_DIRECT_UPLOAD_BYTES = 95 * 1024 * 1024;

/** Default per-project budget across all stored debug files. */
export const DEFAULT_PROJECT_DEBUG_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** Chunk size advertised to sentry-cli; also the R2 multipart part size. */
export const DIF_CHUNK_SIZE = 8 * 1024 * 1024;
export const DIF_CHUNKS_PER_REQUEST = 64;
export const DIF_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Assemblies up to this size run inside the request; bigger ones go to the queue. */
export const INLINE_ASSEMBLY_MAX_BYTES = 64 * 1024 * 1024;

/** File names are display metadata only; never used in keys. */
export const MAX_DEBUG_FILE_NAME = 200;

export function debugFilesPrefix(projectId: string): string {
	return `p/${projectId}/dif/`;
}

export function debugFileKey(projectId: string, debugId: string, kind: DebugFileKind): string {
	const simple = debugId.replace(/-/g, '').toLowerCase();
	return `${debugFilesPrefix(projectId)}${simple.slice(0, 2)}/${simple.slice(2)}/${
		kind === 'macho' ? 'debuginfo' : 'proguard'
	}`;
}

export function chunkKey(checksum: string): string {
	return `chunks/${checksum}`;
}

export function stagingKey(projectId: string): string {
	return `staging/${projectId}/${crypto.randomUUID()}`;
}

/**
 * Normalize a debug id to a lowercase dashed UUID. Accepts dashed or
 * 32-hex forms, with or without a breakpad-style age appendix (`-0`,
 * trailing hex). Returns null for anything else.
 */
export function normalizeDebugId(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().toLowerCase();
	const dashed =
		/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(?:-[0-9a-f]+)?$/.exec(
			trimmed,
		);
	const simple = dashed
		? dashed.slice(1).join('')
		: /^([0-9a-f]{32})[0-9a-f]{0,8}$/.exec(trimmed)?.[1];
	if (!simple) return null;
	return `${simple.slice(0, 8)}-${simple.slice(8, 12)}-${simple.slice(12, 16)}-${simple.slice(
		16,
		20,
	)}-${simple.slice(20)}`;
}

/** sentry-cli names ProGuard uploads `/proguard/{uuid}.txt`; returns the UUID if so. */
export function proguardIdFromName(name: string | undefined | null): string | null {
	if (!name) return null;
	const match = /(?:^|\/)proguard\/([0-9a-fA-F-]{32,36})\.txt$/.exec(name);
	return match ? normalizeDebugId(match[1]) : null;
}

/**
 * Whether text looks like a ProGuard/R8 mapping: the first meaningful line
 * maps a class (`original.Name -> a.b:`). Comment lines (`#`, R8 headers)
 * and blank lines are skipped.
 */
export function looksLikeProguardMapping(head: Uint8Array): boolean {
	const text = new TextDecoder().decode(head.subarray(0, 64 * 1024));
	for (const line of text.split('\n')) {
		const trimmed = line.trimEnd();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		return /^\S.* -> \S+:$/.test(trimmed);
	}
	return false;
}

function uuidFromHash(hash: Uint8Array, version: number): string {
	const bytes = hash.slice(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | (version << 4);
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return normalizeDebugId(bytesToHex(bytes)) as string;
}

function uuidBytes(uuid: string): Uint8Array {
	const hex = uuid.replace(/-/g, '');
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Namespace sentry-cli/symbolic derive ProGuard UUIDs from: uuid5(DNS, "guardsquare.com"). */
const PROGUARD_NAMESPACE = (() => {
	const h = sha1.create();
	h.update(uuidBytes(NAMESPACE_DNS));
	h.update(utf8ToBytes('guardsquare.com'));
	return uuidFromHash(h.digest(), 5);
})();

/**
 * Incremental hashing for an upload: the file's SHA-1 (what sentry-cli calls
 * its checksum) and, for ProGuard mappings, the content-derived UUID
 * sentry-cli computes when no `--uuid` is given (uuid5 over the content).
 */
export class UploadHasher {
	private readonly file = sha1.create();
	private readonly proguard = sha1.create();

	constructor() {
		this.proguard.update(uuidBytes(PROGUARD_NAMESPACE));
	}

	update(bytes: Uint8Array): void {
		this.file.update(bytes);
		this.proguard.update(bytes);
	}

	/** Returns `{sha1, proguardUuid}`; call once, after the last update. */
	finish(): { sha1: string; proguardUuid: string } {
		return {
			sha1: bytesToHex(this.file.digest()),
			proguardUuid: uuidFromHash(this.proguard.digest(), 5),
		};
	}
}

/**
 * Streams bytes into one R2 object without knowing the total length up
 * front: small objects are a single put, larger ones a multipart upload
 * with uniform parts (R2 requires every part but the last to be the same
 * size, at least 5 MiB).
 */
export class R2ObjectWriter {
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private upload: R2MultipartUpload | null = null;
	private parts: R2UploadedPart[] = [];
	private total = 0;

	constructor(
		private readonly bucket: R2Bucket,
		private readonly key: string,
		private readonly partSize = DIF_CHUNK_SIZE,
	) {}

	get size(): number {
		return this.total;
	}

	async write(bytes: Uint8Array): Promise<void> {
		if (bytes.length === 0) return;
		this.pending.push(bytes);
		this.pendingBytes += bytes.length;
		this.total += bytes.length;
		while (this.pendingBytes >= this.partSize) {
			await this.flushPart(this.take(this.partSize));
		}
	}

	async close(): Promise<number> {
		const rest = this.take(this.pendingBytes);
		if (!this.upload) {
			await this.bucket.put(this.key, rest);
			return this.total;
		}
		if (rest.length > 0) await this.flushPart(rest);
		await this.upload.complete(this.parts);
		return this.total;
	}

	async abort(): Promise<void> {
		this.pending = [];
		this.pendingBytes = 0;
		if (this.upload) {
			try {
				await this.upload.abort();
			} catch {
				// Best effort: unfinished multipart uploads expire on their own.
			}
		}
	}

	private take(count: number): Uint8Array {
		const out = new Uint8Array(count);
		let filled = 0;
		while (filled < count) {
			const head = this.pending[0];
			const needed = count - filled;
			if (head.length <= needed) {
				out.set(head, filled);
				filled += head.length;
				this.pending.shift();
			} else {
				out.set(head.subarray(0, needed), filled);
				this.pending[0] = head.subarray(needed);
				filled += needed;
			}
		}
		this.pendingBytes -= count;
		return out;
	}

	private async flushPart(bytes: Uint8Array): Promise<void> {
		if (!this.upload) this.upload = await this.bucket.createMultipartUpload(this.key);
		this.parts.push(await this.upload.uploadPart(this.parts.length + 1, bytes));
	}
}

/** Public shape of a stored debug file (native API, MCP). */
export interface DebugFileRecord {
	id: string;
	debugId: string;
	kind: DebugFileKind;
	arch: string | null;
	name: string;
	size: number;
	sha1: string | null;
	createdAt: string;
}

/** Sentry's DebugFile serializer subset (sentry-cli reads these fields). */
export function serializeSentryDebugFile(file: DebugFileRecord): Record<string, unknown> {
	return {
		id: file.id,
		uuid: file.debugId,
		debugId: file.debugId,
		codeId: null,
		cpuName: file.arch ?? 'any',
		objectName: file.name,
		symbolType: file.kind,
		headers: {},
		size: file.size,
		sha1: file.sha1,
		dateCreated: file.createdAt,
		// sentry-cli parses `type` as an object kind (dbg, exe, lib…) and
		// rejects the whole response on an unknown value, so mappings omit it.
		data: file.kind === 'macho' ? { type: 'dbg', features: ['debug'] } : { features: [] },
	};
}

/** Debug ids an event refers to, from its `debug_meta.images`. */
export interface EventDebugImage {
	debugId: string;
	kind: DebugFileKind;
	codeFile: string | null;
	arch: string | null;
}

export function eventDebugImages(event: unknown): EventDebugImage[] {
	const images = (event as { debug_meta?: { images?: unknown } } | null)?.debug_meta?.images;
	if (!Array.isArray(images)) return [];
	const out: EventDebugImage[] = [];
	const seen = new Set<string>();
	for (const image of images) {
		if (!image || typeof image !== 'object') continue;
		const record = image as Record<string, unknown>;
		const type = record.type;
		let kind: DebugFileKind | null = null;
		if (type === 'macho' || type === 'apple' || type === 'symbolic') kind = 'macho';
		else if (type === 'proguard') kind = 'proguard';
		if (!kind) continue;
		const debugId = normalizeDebugId(record.debug_id ?? record.uuid);
		if (!debugId || seen.has(`${kind}:${debugId}`)) continue;
		seen.add(`${kind}:${debugId}`);
		out.push({
			debugId,
			kind,
			codeFile: typeof record.code_file === 'string' ? record.code_file : null,
			arch: typeof record.arch === 'string' ? record.arch : null,
		});
	}
	return out;
}

/**
 * The debug images a crash cannot be read without: native images that hold
 * an in-app frame (system libraries never ship a dSYM and are not needed),
 * and every ProGuard mapping. Drives the "dSYM missing" / "Mapping missing"
 * tag, the issue's Debug files card and reprocessing after an upload.
 */
export function neededDebugImages(event: unknown): EventDebugImage[] {
	const all = eventDebugImages(event);
	if (all.length === 0) return [];
	const record = event as Record<string, unknown>;
	const rawImages = ((record.debug_meta as { images?: unknown } | undefined)?.images ??
		[]) as unknown[];
	const ranges: Array<{ debugId: string; base: bigint; end: bigint | null }> = [];
	for (const raw of rawImages) {
		if (!raw || typeof raw !== 'object') continue;
		const image = raw as Record<string, unknown>;
		const debugId = normalizeDebugId(image.debug_id ?? image.uuid);
		const base = toBigAddress(image.image_addr);
		if (!debugId || base === null) continue;
		const size =
			typeof image.image_size === 'number' && image.image_size > 0
				? BigInt(image.image_size)
				: null;
		ranges.push({ debugId, base, end: size === null ? null : base + size });
	}
	const neededNative = new Set<string>();
	for (const frame of inAppFrames(record)) {
		const addr = toBigAddress(frame.instruction_addr);
		if (addr === null) continue;
		let best: { debugId: string; base: bigint } | null = null;
		for (const range of ranges) {
			if (addr < range.base || (range.end !== null && addr >= range.end)) continue;
			if (!best || range.base > best.base) best = range;
		}
		if (best) neededNative.add(best.debugId);
	}
	return all.filter((image) => image.kind === 'proguard' || neededNative.has(image.debugId));
}

function toBigAddress(value: unknown): bigint | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
	if (typeof value === 'string' && /^0x[0-9a-f]{1,16}$/i.test(value)) return BigInt(value);
	return null;
}

/** In-app frames of every stack trace (originals when the event was symbolicated). */
function inAppFrames(event: Record<string, unknown>): Array<Record<string, unknown>> {
	const holders: unknown[] = [];
	const exception = event.exception as { values?: unknown[] } | undefined;
	if (Array.isArray(exception?.values)) holders.push(...exception.values);
	const threads = event.threads as { values?: unknown[] } | unknown[] | undefined;
	const threadValues = Array.isArray(threads) ? threads : threads?.values;
	if (Array.isArray(threadValues)) holders.push(...threadValues);
	holders.push(event);
	const frames: Array<Record<string, unknown>> = [];
	for (const holder of holders) {
		if (!holder || typeof holder !== 'object') continue;
		const h = holder as Record<string, unknown>;
		const trace = (h.raw_stacktrace ?? h.stacktrace) as { frames?: unknown[] } | undefined;
		if (!Array.isArray(trace?.frames)) continue;
		for (const frame of trace.frames) {
			if (
				frame &&
				typeof frame === 'object' &&
				(frame as Record<string, unknown>).in_app === true
			) {
				frames.push(frame as Record<string, unknown>);
			}
		}
	}
	return frames;
}
