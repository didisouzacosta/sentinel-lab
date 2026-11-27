import { Container } from '@cloudflare/containers';
import type { DebugFileRecord } from './lib/debug-files';
import { debugFileKey, normalizeDebugId } from './lib/debug-files';
import {
	buildJvmRequest,
	buildNativeRequest,
	DIF_SOURCE_HOST,
	mergeJvmResult,
	mergeNativeResult,
} from './lib/symbolicate';
import type { Env } from './types';

/**
 * Symbolicator (getsentry/symbolicator, image in `symbolicator/`) as a
 * Cloudflare Container. One instance serves every project: each request
 * names its project's debug-file source, and Symbolicator's cache is scoped
 * per project (`scope` query parameter).
 *
 * The container has no internet access. Its only way out is
 * `http://sentinel.internal/…`, intercepted below and answered by Worker
 * code from the `DEBUG_FILES` bucket — no R2 credentials enter the
 * container.
 */
export class Symbolicator extends Container<Env> {
	defaultPort = 3021;
	sleepAfter = '10m';
	enableInternet = false;
	pingEndpoint = 'container/healthcheck';
}

// Assigned after the class, not as a `static` field: a class field is
// defined with [[DefineOwnProperty]] and skips the setter on Container that
// registers the handler — the container then gets 520 for every request.
Symbolicator.outboundByHost = {
	[DIF_SOURCE_HOST]: (request: Request, env: unknown) => serveDebugFiles(request, env as Env),
};

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
export async function serveDebugFiles(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const match = /^\/dif\/([A-Za-z0-9-]{1,64})\/?$/.exec(url.pathname);
	if (request.method !== 'GET' || !match || !env.DEBUG_FILES) {
		return json({ error: 'not_found' }, 404);
	}
	const projectId = match[1];
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

/** POST a request to the Symbolicator container and wait for its answer. */
async function callSymbolicator(
	env: Env,
	path: '/symbolicate' | '/symbolicate-jvm',
	body: Json,
	scope: string,
): Promise<Json> {
	if (!env.SYMBOLICATOR) throw new SymbolicatorError('symbolicator_unconfigured');
	const stub = env.SYMBOLICATOR.getByName('symbolicator');
	const deadline = Date.now() + SYMBOLICATION_DEADLINE_MS;
	const query = `timeout=${POLL_TIMEOUT_SECONDS}&scope=${encodeURIComponent(scope)}`;
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
	const native = buildNativeRequest(event, projectId);
	if (native) {
		frames += mergeNativeResult(
			event,
			native,
			await callSymbolicator(env, '/symbolicate', native.body, projectId),
		);
	}
	const jvm = buildJvmRequest(event, projectId);
	if (jvm) {
		frames += mergeJvmResult(
			jvm,
			await callSymbolicator(env, '/symbolicate-jvm', jvm.body, projectId),
		);
	}
	return { frames };
}
