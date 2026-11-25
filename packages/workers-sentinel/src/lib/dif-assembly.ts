import type { Env } from '../types';
import type { DebugFileRecord } from './debug-files';
import { chunkKey, MAX_DEBUG_FILE_BYTES, proguardIdFromName } from './debug-files';
import { type DifIngestResult, ingestDebugFile, type StoredDebugFile } from './dif-ingest';

/**
 * Glue between uploads and ProjectState: register stored files (cleaning up
 * on refusal) and assemble sentry-cli chunk uploads. Used by the routes and
 * by the queue consumer for large assemblies.
 */

export async function projectStateCall<T>(
	env: Env,
	projectId: string,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
	const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
	const response = await stub.fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...body, projectId }),
		}),
	);
	return { status: response.status, data: (await response.json()) as T };
}

export type RegisterOutcome =
	| { ok: true; files: DebugFileRecord[] }
	| { ok: false; status: number; error: string; message: string };

/** Register what an ingest stored; on a quota refusal, delete the new objects. */
export async function registerStoredFiles(
	env: Env,
	bucket: R2Bucket,
	projectId: string,
	files: StoredDebugFile[],
): Promise<RegisterOutcome> {
	const { status, data } = await projectStateCall<{
		files?: DebugFileRecord[];
		error?: string;
		message?: string;
		orphanKeys?: string[];
	}>(env, projectId, '/debug-files/register', { files });
	if (status === 200 && data.files) return { ok: true, files: data.files };
	if (data.orphanKeys?.length) await bucket.delete(data.orphanKeys);
	return {
		ok: false,
		status,
		error: data.error ?? 'register_failed',
		message: data.message ?? 'Could not register the debug file',
	};
}

export interface AssembleJob {
	projectId: string;
	checksum: string;
	name: string;
	debugId: string | null;
	chunks: string[];
}

async function* chunkStream(bucket: R2Bucket, chunks: string[]): AsyncGenerator<Uint8Array> {
	for (const checksum of chunks) {
		const object = await bucket.get(chunkKey(checksum));
		if (!object) throw new MissingChunkError(checksum);
		yield new Uint8Array(await object.arrayBuffer());
	}
}

class MissingChunkError extends Error {
	constructor(readonly checksum: string) {
		super(`chunk ${checksum} is missing`);
	}
}

/**
 * Concatenate the chunks, store the result as debug files and record the
 * assembly outcome. Never throws for content problems (they become an
 * `error` state sentry-cli prints); R2/DO failures throw so a queue retries.
 */
export async function assembleDebugFile(
	env: Env,
	bucket: R2Bucket,
	job: AssembleJob,
): Promise<void> {
	const set = (state: string, extra: Record<string, unknown> = {}) =>
		projectStateCall(env, job.projectId, '/dif-assembly/set', {
			checksum: job.checksum,
			state,
			name: job.name,
			debugId: job.debugId,
			...extra,
		});

	await set('assembling');
	const proguardId = proguardIdFromName(job.name);
	let result: DifIngestResult;
	try {
		result = await ingestDebugFile(bucket, chunkStream(bucket, job.chunks), {
			projectId: job.projectId,
			name: job.name,
			kind: proguardId ? 'proguard' : null,
			debugId: proguardId,
			maxBytes: MAX_DEBUG_FILE_BYTES,
			skipExecutables: true,
		});
	} catch (error) {
		if (error instanceof MissingChunkError) {
			await set('error', { detail: `${error.message}; upload again` });
			return;
		}
		throw error;
	}
	if (!result.ok) {
		await set('error', { detail: result.message });
		return;
	}
	if (result.sha1 !== job.checksum) {
		await bucket.delete(result.files.map((file) => file.r2Key));
		await set('error', {
			detail: 'checksum mismatch: the chunks do not add up to the declared file',
		});
		return;
	}
	if (result.files.length === 0 && result.skipped?.length) {
		await set('ok', {
			detail: 'app binary without debug information: acknowledged, not stored (upload its .dSYM)',
			debugId: result.skipped[0].debugId,
			fileIds: [],
		});
		return;
	}
	const registered = await registerStoredFiles(env, bucket, job.projectId, result.files);
	if (!registered.ok) {
		await set('error', { detail: registered.message });
		return;
	}
	await set('ok', { detail: null, fileIds: registered.files.map((file) => file.id) });
}
