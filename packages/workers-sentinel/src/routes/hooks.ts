/**
 * Webhooks from integrations (public: no session, no API token). Kaneo calls
 * POST /api/hooks/kaneo/:projectId when a task changes; Sentinel installed
 * that webhook with a per-project secret when the project was connected
 * (routes/integrations.ts), and Kaneo signs every delivery with it:
 * `X-Kaneo-Signature` = hex HMAC-SHA256 of the raw body.
 *
 * Every rejection is the same `401 invalid_signature`, whether the project
 * does not exist, is not connected or the signature is wrong, so the route
 * reveals nothing. ProjectState is only touched for projects AuthState knows,
 * so made-up ids never create Durable Objects.
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { openSecret } from '../lib/secret-box';
import type { Env } from '../types';
import { loadIntegration } from './integrations';

export const hookRoutes = new Hono<{ Bindings: Env }>();

/** Kaneo payloads are small; anything bigger is refused while streaming. */
const MAX_HOOK_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

const encoder = new TextEncoder();

function deny() {
	return Response.json({ error: 'invalid_signature' }, { status: 401 });
}

/** Read the raw body, stopping as soon as it exceeds `max` bytes. */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (declared > max) return null;
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** Constant-time check of a hex HMAC-SHA256 signature. */
export async function verifyHexSignature(
	secret: string,
	body: Uint8Array,
	signatureHex: string,
): Promise<boolean> {
	if (!HEX_SHA256.test(signatureHex)) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
	const given = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		given[i] = Number.parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
	}
	return crypto.subtle.timingSafeEqual(expected, given);
}

async function projectExists(env: Env, projectId: string): Promise<boolean> {
	const authState = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
	const response = await authState.fetch(
		new Request('http://internal/project-exists', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId }),
		}),
	);
	if (!response.ok) return false;
	return ((await response.json()) as { exists?: boolean }).exists === true;
}

interface KaneoHookPayload {
	event?: unknown;
	task?: { id?: unknown; status?: unknown };
	actor?: { name?: unknown };
	data?: { oldStatus?: unknown; newStatus?: unknown };
}

hookRoutes.post('/kaneo/:projectId', async (c) => {
	const projectId = c.req.param('projectId');
	const signature = c.req.header('X-Kaneo-Signature') ?? '';
	// Cheap checks first: no storage is touched for requests that cannot be valid.
	if (!UUID.test(projectId) || !HEX_SHA256.test(signature)) return deny();
	if (!c.env.INTEGRATIONS_KEY) {
		return c.json({ error: 'integrations_unconfigured' }, 503);
	}

	const body = await readBody(c.req.raw, MAX_HOOK_BODY_BYTES);
	if (!body) return c.json({ error: 'body_too_large' }, 413);

	if (!(await projectExists(c.env, projectId.toLowerCase()))) return deny();
	const integration = await loadIntegration(c.env, projectId.toLowerCase(), 'kaneo');
	if (!integration?.enabled || !integration.webhookSecretCipher) return deny();
	let secret: string;
	try {
		secret = await openSecret(
			c.env.INTEGRATIONS_KEY,
			projectId.toLowerCase(),
			integration.webhookSecretCipher,
		);
	} catch {
		return deny();
	}
	if (!(await verifyHexSignature(secret, body, signature))) return deny();

	let payload: KaneoHookPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(body)) as KaneoHookPayload;
	} catch {
		return c.json({ error: 'invalid_json' }, 400);
	}
	const taskId = typeof payload.task?.id === 'string' ? payload.task.id : null;
	if (!taskId) return c.body(null, 204);

	let action: Record<string, unknown>;
	if (payload.event === 'task.status_changed') {
		const text = (value: unknown) => (typeof value === 'string' ? value : null);
		action = {
			action: 'status',
			taskId,
			oldStatus: text(payload.data?.oldStatus),
			newStatus: text(payload.data?.newStatus) ?? text(payload.task?.status),
			actorName: text(payload.actor?.name),
		};
	} else if (payload.event === 'task.deleted') {
		action = { action: 'deleted', taskId };
	} else {
		return c.body(null, 204);
	}

	const projectState = c.env.PROJECT_STATE.get(
		c.env.PROJECT_STATE.idFromName(projectId.toLowerCase()),
	);
	const response = await projectState.fetch(
		new Request('http://internal/integrations/kaneo-hook', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(action),
		}),
	);
	return c.json(await response.json(), response.status as ContentfulStatusCode);
});
