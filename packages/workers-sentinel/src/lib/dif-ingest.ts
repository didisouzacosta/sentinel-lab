import {
	type DebugFileKind,
	debugFileKey,
	looksLikeProguardMapping,
	normalizeDebugId,
	R2ObjectWriter,
	stagingKey,
	UploadHasher,
} from './debug-files';
import { MACHO_HEADER_READ_BYTES, type MachOObject, MH_DSYM, machOKind, parseMachO } from './macho';

/**
 * Turns one uploaded file (a stream of bytes, wherever it came from: a
 * request body or assembled chunks) into stored debug files:
 *
 * - thin Mach-O dSYM object → one `debuginfo` object under its UUID;
 * - universal (fat) dSYM → one object per architecture slice;
 * - ProGuard/R8 mapping → one `proguard` object under the given UUID, or the
 *   content-derived one sentry-cli computes.
 *
 * Executables without DWARF and unknown formats are refused with a reason
 * the uploader can act on. R2 failures throw (callers answer 503).
 */

export interface StoredDebugFile {
	debugId: string;
	kind: DebugFileKind;
	arch: string | null;
	name: string;
	size: number;
	sha1: string;
	r2Key: string;
}

export type DifIngestResult =
	| {
			ok: true;
			files: StoredDebugFile[];
			sha1: string;
			/** Executables acknowledged but not stored (`skipExecutables`). */
			skipped?: Array<{ debugId: string; arch: string }>;
	  }
	| { ok: false; status: 400 | 413; error: string; message: string };

export interface DifIngestOptions {
	projectId: string;
	name: string;
	/** What the uploader says it is; detection still decides. */
	kind?: 'dsym' | 'proguard' | null;
	/** ProGuard UUID (from `--uuid`, the upload name, or the API). Ignored for Mach-O. */
	debugId?: string | null;
	maxBytes: number;
	/**
	 * Accept a Mach-O without DWARF (the app binary) as a no-op instead of
	 * refusing it. sentry-cli uploads the binary next to its dSYM from
	 * Xcode's products folder and fails the whole run on a refusal; the
	 * dSYM is what matters, and a binary never replaces it.
	 */
	skipExecutables?: boolean;
}

class TooLargeError extends Error {}

const refuse = (status: 400 | 413, error: string, message: string): DifIngestResult => ({
	ok: false,
	status,
	error,
	message,
});

/** Pull-based reader with a peekable head. */
class ByteReader {
	private readonly iterator: AsyncIterator<Uint8Array>;
	private head: Uint8Array[] = [];
	private consumed = 0;

	constructor(
		source: AsyncIterable<Uint8Array>,
		private readonly maxBytes: number,
	) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	private async next(): Promise<Uint8Array | null> {
		const step = await this.iterator.next();
		if (step.done) return null;
		this.consumed += step.value.length;
		if (this.consumed > this.maxBytes) throw new TooLargeError();
		return step.value;
	}

	/** First bytes of the file (at least `count` unless the file is shorter). Not consumed. */
	async peek(count: number): Promise<Uint8Array> {
		let have = this.head.reduce((sum, part) => sum + part.length, 0);
		while (have < count) {
			const part = await this.next();
			if (!part) break;
			this.head.push(part);
			have += part.length;
		}
		const out = new Uint8Array(have);
		let offset = 0;
		for (const part of this.head) {
			out.set(part, offset);
			offset += part.length;
		}
		this.head = have > 0 ? [out] : [];
		return out;
	}

	async *drain(): AsyncGenerator<Uint8Array> {
		for (const part of this.head) yield part;
		this.head = [];
		for (;;) {
			const part = await this.next();
			if (!part) return;
			yield part;
		}
	}
}

/** A Mach-O with a UUID but no debug information: the app binary, not its dSYM. */
function isExecutable(object: MachOObject | null): object is MachOObject & { uuid: string } {
	return !!object?.uuid && object.fileType !== MH_DSYM && !object.hasDwarf;
}

async function drainHashing(chunks: AsyncIterable<Uint8Array>): Promise<string> {
	const hasher = new UploadHasher();
	for await (const chunk of chunks) hasher.update(chunk);
	return hasher.finish().sha1;
}

function validateDsymObject(object: MachOObject | null): string | null {
	if (!object) return 'not a Mach-O object';
	if (object.fileType !== MH_DSYM && !object.hasDwarf) {
		return 'this Mach-O file has no debug information (upload the .dSYM, not the app binary)';
	}
	if (!object.uuid) return 'this Mach-O object has no LC_UUID';
	return null;
}

async function writeAll(
	bucket: R2Bucket,
	key: string,
	chunks: AsyncIterable<Uint8Array>,
	hasher: UploadHasher,
): Promise<number> {
	const writer = new R2ObjectWriter(bucket, key);
	try {
		for await (const chunk of chunks) {
			hasher.update(chunk);
			await writer.write(chunk);
		}
		return await writer.close();
	} catch (error) {
		await writer.abort();
		throw error;
	}
}

/** Copy `[offset, offset + length)` of one object into another, hashing it on the way. */
async function copyRange(
	bucket: R2Bucket,
	from: string,
	to: string,
	offset: number,
	length: number,
): Promise<string> {
	const source = await bucket.get(from, { range: { offset, length } });
	if (!source) throw new Error('staged upload disappeared');
	const hasher = new UploadHasher();
	const writer = new R2ObjectWriter(bucket, to);
	try {
		const reader = source.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
			await writer.write(value);
		}
		await writer.close();
	} catch (error) {
		await writer.abort();
		throw error;
	}
	return hasher.finish().sha1;
}

async function readRange(
	bucket: R2Bucket,
	key: string,
	offset: number,
	length: number,
): Promise<Uint8Array> {
	const object = await bucket.get(key, { range: { offset, length } });
	if (!object) throw new Error('staged upload disappeared');
	return new Uint8Array(await object.arrayBuffer());
}

export async function ingestDebugFile(
	bucket: R2Bucket,
	source: AsyncIterable<Uint8Array>,
	options: DifIngestOptions,
): Promise<DifIngestResult> {
	const reader = new ByteReader(source, options.maxBytes);
	try {
		return await ingest(bucket, reader, options);
	} catch (error) {
		if (error instanceof TooLargeError) {
			return refuse(
				413,
				'too_large',
				`Debug files are limited to ${options.maxBytes} bytes per upload`,
			);
		}
		throw error;
	}
}

async function ingest(
	bucket: R2Bucket,
	reader: ByteReader,
	options: DifIngestOptions,
): Promise<DifIngestResult> {
	const head = await reader.peek(MACHO_HEADER_READ_BYTES);
	if (head.length === 0) return refuse(400, 'empty_file', 'The upload is empty');
	const name = options.name;
	const shape = machOKind(head);

	if (options.kind !== 'proguard' && shape.kind === 'thin') {
		const object = parseMachO(head);
		if (options.skipExecutables && isExecutable(object)) {
			const sha1 = await drainHashing(reader.drain());
			return { ok: true, sha1, files: [], skipped: [{ debugId: object.uuid, arch: object.arch }] };
		}
		const problem = validateDsymObject(object);
		if (problem || !object?.uuid) return refuse(400, 'not_debug_file', problem ?? 'invalid Mach-O');
		const key = debugFileKey(options.projectId, object.uuid, 'macho');
		const hasher = new UploadHasher();
		const size = await writeAll(bucket, key, reader.drain(), hasher);
		const { sha1 } = hasher.finish();
		return {
			ok: true,
			sha1,
			files: [
				{ debugId: object.uuid, kind: 'macho', arch: object.arch, name, size, sha1, r2Key: key },
			],
		};
	}

	if (options.kind !== 'proguard' && shape.kind === 'fat') {
		const staged = stagingKey(options.projectId);
		const hasher = new UploadHasher();
		try {
			const total = await writeAll(bucket, staged, reader.drain(), hasher);
			const slices: Array<{
				object: MachOObject & { uuid: string };
				offset: number;
				size: number;
			}> = [];
			for (const slice of shape.slices) {
				if (slice.offset + slice.size > total) {
					return refuse(
						400,
						'not_debug_file',
						'universal Mach-O slice runs past the end of the file',
					);
				}
				const object = parseMachO(
					await readRange(
						bucket,
						staged,
						slice.offset,
						Math.min(slice.size, MACHO_HEADER_READ_BYTES),
					),
				);
				if (options.skipExecutables && isExecutable(object)) {
					slices.push({ object, ...slice });
					continue;
				}
				const problem = validateDsymObject(object);
				if (problem || !object?.uuid)
					return refuse(400, 'not_debug_file', problem ?? 'invalid Mach-O');
				slices.push({ object: object as MachOObject & { uuid: string }, ...slice });
			}
			if (slices.some((slice) => isExecutable(slice.object))) {
				return {
					ok: true,
					sha1: hasher.finish().sha1,
					files: [],
					skipped: slices.map((slice) => ({ debugId: slice.object.uuid, arch: slice.object.arch })),
				};
			}
			const files: StoredDebugFile[] = [];
			for (const slice of slices) {
				const key = debugFileKey(options.projectId, slice.object.uuid, 'macho');
				const sha1 = await copyRange(bucket, staged, key, slice.offset, slice.size);
				files.push({
					debugId: slice.object.uuid,
					kind: 'macho',
					arch: slice.object.arch,
					name,
					size: slice.size,
					sha1,
					r2Key: key,
				});
			}
			return { ok: true, sha1: hasher.finish().sha1, files };
		} finally {
			await bucket.delete(staged);
		}
	}

	if (options.kind === 'dsym') {
		return refuse(400, 'not_debug_file', 'not a Mach-O dSYM object');
	}

	if (!looksLikeProguardMapping(head)) {
		return refuse(
			400,
			'unsupported_file',
			'Unsupported file: expected a dSYM (Mach-O with DWARF) or a ProGuard/R8 mapping.txt',
		);
	}

	const given = options.debugId == null ? null : normalizeDebugId(options.debugId);
	if (options.debugId != null && !given) {
		return refuse(400, 'invalid_debug_id', 'The ProGuard UUID must be a UUID');
	}
	const hasher = new UploadHasher();
	if (given) {
		const key = debugFileKey(options.projectId, given, 'proguard');
		const size = await writeAll(bucket, key, reader.drain(), hasher);
		const { sha1 } = hasher.finish();
		return {
			ok: true,
			sha1,
			files: [{ debugId: given, kind: 'proguard', arch: null, name, size, sha1, r2Key: key }],
		};
	}
	// No UUID given: it derives from the whole content, so stage first.
	const staged = stagingKey(options.projectId);
	try {
		const size = await writeAll(bucket, staged, reader.drain(), hasher);
		const { sha1, proguardUuid } = hasher.finish();
		const key = debugFileKey(options.projectId, proguardUuid, 'proguard');
		await copyRange(bucket, staged, key, 0, size);
		return {
			ok: true,
			sha1,
			files: [
				{ debugId: proguardUuid, kind: 'proguard', arch: null, name, size, sha1, r2Key: key },
			],
		};
	} finally {
		await bucket.delete(staged);
	}
}
