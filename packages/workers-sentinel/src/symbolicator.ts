import { Container, type OutboundHandlerContext } from '@cloudflare/containers';
import type { DebugFileRecord } from './lib/debug-files';
import { debugFileKey, normalizeDebugId } from './lib/debug-files';
import {
	buildJvmRequest,
	buildNativeRequest,
	DIF_SOURCE_HOST,
	mergeJvmResult,
	mergeNativeResult,
} from './lib/symbolicate';
import {
	type CachedAnswer,
	type CacheKey,
	cacheKey,
	rebaseAnswer,
	type SymbolicatorPath,
} from './lib/symbolication-cache';
import type { Env } from './types';

/**
 * Symbolicator (getsentry/symbolicator, image in `symbolicator/`) as a
 * Cloudflare Container, one instance per project
 * (`SYMBOLICATOR.getByName(projectId)`), so a project's debug files only
 * ever reach that project's process (docs/plano-riscos-simbolizacao.md,
 * phase 1).
 *
 * The container has no internet access. Its only way out is
 * `http://sentinel.internal/…`, intercepted below and answered by Worker
 * code from the `DEBUG_FILES` bucket — no R2 credentials enter the
 * container. The handler serves `/dif/{projectId}/` only to the instance
 * named after that project.
 */
export class Symbolicator extends Container<Env> {
	defaultPort = 3021;
	// Per-project instances: sleep soon after a crash burst so idle cost
	// does not add up across projects.
	sleepAfter = '3m';
	enableInternet = false;
	pingEndpoint = 'container/healthcheck';
}

// Assigned after the class, not as a `static` field: a class field is
// defined with [[DefineOwnProperty]] and skips the setter on Container that
// registers the handler — the container then gets 520 for every request.
// `ctx.containerId` is set by the runtime (the instance's Durable Object
// id), never by the process inside the container.
Symbolicator.outboundByHost = {
	[DIF_SOURCE_HOST]: (request: Request, env: unknown, ctx: OutboundHandlerContext) =>
		serveDebugFiles(request, env as Env, ctx.containerId),
};

/** The instance that symbolicates a project's events. */
export function symbolicatorFor(env: Env, projectId: string) {
	if (!env.SYMBOLICATOR) throw new SymbolicatorError('symbolicator_unconfigured');
	return env.SYMBOLICATOR.getByName(projectId);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * The "sentry" source protocol Symbolicator speaks
 * (symbolicator-service/src/download/sentry.rs):
 *
 * - `GET /dif/{projectId}/?debug_id=…&code_id=…` → `[{id, symbolType}]`
 * - `GET /dif/{projectId}/?id=…` → the file's bytes
 */
export async function serveDebugFiles(
	request: Request,
	env: Env,
	containerId: string,
): Promise<Response> {
	const url = new URL(request.url);
	const match = /^\/dif\/([A-Za-z0-9-]{1,64})\/?$/.exec(url.pathname);
	if (request.method !== 'GET' || !match || !env.DEBUG_FILES) {
		return json({ error: 'not_found' }, 404);
	}
	const projectId = match[1];
	// Only the project's own instance may read its files. A mismatch means
	// the process inside a container asked for another project's files:
	// refuse and leave a trace.
	if (!env.SYMBOLICATOR || env.SYMBOLICATOR.idFromName(projectId).toString() !== containerId) {
		console.warn(
			JSON.stringify({
				event: 'symbolication.isolation_violation',
				projectId,
				containerId: String(containerId).slice(0, 64),
			}),
		);
		return json({ error: 'forbidden' }, 403);
	}
	const projectState = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
	const call = (path: string, body: unknown) =>
		projectState.fetch(
			new Request(`http://internal${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);

	const fileId = url.searchParams.get('id');
	if (fileId) {
		const response = await call('/debug-files/get', { id: fileId });
		if (!response.ok) return json({ error: 'not_found' }, 404);
		const { debugFile } = (await response.json()) as { debugFile: DebugFileRecord };
		const object = await env.DEBUG_FILES.get(
			debugFileKey(projectId, debugFile.debugId, debugFile.kind),
		);
		if (!object) return json({ error: 'not_found' }, 404);
		return new Response(object.body, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(object.size),
			},
		});
	}

	const debugIds = [url.searchParams.get('debug_id'), url.searchParams.get('code_id')]
		.map(normalizeDebugId)
		.filter((id): id is string => id !== null);
	if (debugIds.length === 0) return json([]);
	const response = await call('/debug-files/lookup', { debugIds: [...new Set(debugIds)] });
	if (!response.ok) return json({ error: 'lookup_failed' }, 502);
	const { found } = (await response.json()) as { found: DebugFileRecord[] };
	return json(found.map((file) => ({ id: file.id, symbolType: file.kind })));
}

/** How long one symbolication may take before the job is retried. */
const SYMBOLICATION_DEADLINE_MS = 4 * 60 * 1000;
const POLL_TIMEOUT_SECONDS = 30;

export class SymbolicatorError extends Error {}

/**
 * Symbolicator refused the request itself (4xx other than 408/429, e.g. 422
 * for a field of the wrong shape). Retrying cannot help: the job stores the
 * event as received right away.
 */
export class SymbolicatorRejected extends SymbolicatorError {}

type Json = Record<string, unknown>;

/** POST a request to the project's Symbolicator instance and wait for its answer. */
async function callSymbolicator(
	env: Env,
	path: SymbolicatorPath,
	body: Json,
	projectId: string,
): Promise<Json> {
	const stub = symbolicatorFor(env, projectId);
	const deadline = Date.now() + SYMBOLICATION_DEADLINE_MS;
	const query = `timeout=${POLL_TIMEOUT_SECONDS}&scope=${encodeURIComponent(projectId)}`;
	let response = await stub.fetch(
		new Request(`http://symbolicator${path}?${query}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
	for (;;) {
		if (!response.ok) {
			const status = response.status;
			if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
				throw new SymbolicatorRejected(`symbolicator rejected the request (${status})`);
			}
			throw new SymbolicatorError(`symbolicator answered ${status}`);
		}
		const result = (await response.json()) as Json;
		if (result.status !== 'pending') {
			if (result.status === 'failed' || result.status === 'error') {
				throw new SymbolicatorError(`symbolicator ${String(result.status)}`);
			}
			return result;
		}
		if (typeof result.request_id !== 'string' || Date.now() > deadline) {
			throw new SymbolicatorError('symbolicator timed out');
		}
		response = await stub.fetch(
			new Request(
				`http://symbolicator/requests/${encodeURIComponent(result.request_id)}?timeout=${POLL_TIMEOUT_SECONDS}`,
			),
		);
	}
}

export interface SymbolicationOutcome {
	/** Frames that gained function/file/line information. */
	frames: number;
	/** Answers that came from the cache instead of the container. */
	cacheHits: number;
}

type ProjectStub = { fetch(request: Request): Promise<Response> };

function projectStub(env: Env, projectId: string): ProjectStub {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
}

async function postJson(stub: ProjectStub, path: string, body: unknown): Promise<Json | null> {
	const response = await stub.fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
	return response.ok ? ((await response.json()) as Json) : null;
}

/**
 * callSymbolicator through the project's answer cache
 * (lib/symbolication-cache.ts). Cache trouble never fails symbolication:
 * it just goes to the container.
 */
async function symbolicateCached(
	env: Env,
	path: SymbolicatorPath,
	body: Json,
	projectId: string,
): Promise<{ result: Json; hit: boolean }> {
	const stub = projectStub(env, projectId);
	let key: CacheKey | null = null;
	try {
		key = cacheKey(path, body);
		const cached = await postJson(stub, '/symbolication/cache/get', {
			key: key.key,
			debugIds: key.debugIds,
		});
		if (cached?.hit === true && cached.value && typeof cached.value === 'object') {
			return { result: rebaseAnswer(cached.value as CachedAnswer, key), hit: true };
		}
	} catch (error) {
		console.error(
			'Symbolication cache read failed:',
			error instanceof Error ? error.message.slice(0, 120) : 'unknown',
		);
	}

	const result = await callSymbolicator(env, path, body, projectId);
	if (key && result.status === 'completed') {
		const value: CachedAnswer = { result, bases: key.bases };
		await postJson(stub, '/symbolication/cache/put', {
			key: key.key,
			debugIds: key.debugIds,
			value,
		}).catch(() => null);
	}
	return { result, hit: false };
}

/**
 * Symbolicate an event in place: native frames (dSYM) and/or JVM frames and
 * exception types (ProGuard/R8 mapping), as its `debug_meta` allows. Throws
 * SymbolicatorError when the container cannot answer.
 */
export async function symbolicateEvent(
	env: Env,
	projectId: string,
	event: Json,
): Promise<SymbolicationOutcome> {
	let frames = 0;
	let cacheHits = 0;
	const native = buildNativeRequest(event, projectId);
	if (native) {
		const { result, hit } = await symbolicateCached(env, '/symbolicate', native.body, projectId);
		frames += mergeNativeResult(event, native, result);
		if (hit) cacheHits++;
	}
	const jvm = buildJvmRequest(event, projectId);
	if (jvm) {
		const { result, hit } = await symbolicateCached(env, '/symbolicate-jvm', jvm.body, projectId);
		frames += mergeJvmResult(jvm, result);
		if (hit) cacheHits++;
	}
	return { frames, cacheHits };
}
