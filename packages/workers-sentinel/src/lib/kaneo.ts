/**
 * Thin client for the Kaneo REST API (https://kaneo.app), used by the Kaneo
 * integration. The only credential is the user's Kaneo API key.
 *
 * Transport: plain HTTPS, or — for the Kaneo instance this Worker is bound
 * to (`KANEO` service binding to the Kaneo Worker's `KaneoApi` entrypoint,
 * `KANEO_BINDING_ORIGIN` = its URL) — the binding, which stays inside the
 * Cloudflare account and never crosses Cloudflare Access (`kaneoFetcher`).
 *
 * Outbound hygiene mirrors lib/webhook.ts: https only, no private hosts,
 * redirects never followed (an Access login redirect surfaces as
 * `access_denied`), a 10 s timeout, and response bodies are never logged.
 */

import { validateWebhookUrl } from './webhook';

const KANEO_TIMEOUT_MS = 10_000;
/** Longest Kaneo error message echoed back to the caller. */
const MAX_ERROR_MESSAGE = 160;

export interface KaneoCredentials {
	apiKey: string;
}

/** The bindings that route calls to a Kaneo Worker in the same account. */
export interface KaneoBindingEnv {
	KANEO?: Fetcher;
	KANEO_BINDING_ORIGIN?: string;
}

/**
 * The fetch to use for a Kaneo origin: the `KANEO` service binding when the
 * origin is the bound instance, otherwise the global fetch (undefined).
 */
export function kaneoFetcher(env: KaneoBindingEnv, origin: string): typeof fetch | undefined {
	const binding = env.KANEO;
	if (!binding || !env.KANEO_BINDING_ORIGIN) return undefined;
	const target = normalizeKaneoBaseUrl(origin);
	const bound = normalizeKaneoBaseUrl(env.KANEO_BINDING_ORIGIN);
	if (!target.ok || !bound.ok || target.origin !== bound.origin) return undefined;
	return ((input: RequestInfo | URL, init?: RequestInit) =>
		binding.fetch(input, init)) as typeof fetch;
}

export type KaneoErrorCode =
	| 'invalid_url'
	| 'unreachable'
	| 'access_denied'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'bad_request'
	| 'conflict'
	| 'server_error'
	| 'bad_response';

export class KaneoError extends Error {
	constructor(
		readonly code: KaneoErrorCode,
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface KaneoWorkspace {
	id: string;
	name: string;
	slug: string;
}

export interface KaneoProject {
	id: string;
	name: string;
	slug: string;
	workspaceId: string;
}

export interface KaneoColumn {
	id: string;
	name: string;
	slug: string;
	position: number;
	isFinal: boolean;
}

export interface KaneoTask {
	id: string;
	projectId: string;
	number: number | null;
	title: string;
	status: string;
}

export type KaneoPriority = 'no-priority' | 'low' | 'medium' | 'high' | 'urgent';

export interface KaneoWebhookConfig {
	webhookUrl: string;
	secret: string;
	events: Record<string, boolean>;
}

/** Kaneo's generic-webhook event switches (apps/api plugins/generic-webhook). */
const KANEO_WEBHOOK_EVENTS = [
	'taskCreated',
	'taskStatusChanged',
	'taskPriorityChanged',
	'taskTitleChanged',
	'taskDescriptionChanged',
	'taskCommentCreated',
	'taskDeleted',
	'taskMoved',
	'taskDueDateChanged',
	'taskAssigneeChanged',
	'taskUnassigned',
	'dueDateReminder',
] as const;

/** The webhook Sentinel installs: only status changes and deletions. */
export function sentinelWebhookConfig(webhookUrl: string, secret: string): KaneoWebhookConfig {
	const events = Object.fromEntries(
		KANEO_WEBHOOK_EVENTS.map((key) => [key, key === 'taskStatusChanged' || key === 'taskDeleted']),
	);
	return { webhookUrl, secret, events };
}

/**
 * Normalize what the user typed into the Kaneo origin (scheme + host, no
 * path): `https://kaneo.example.com/api/` → `https://kaneo.example.com`.
 */
export function normalizeKaneoBaseUrl(
	raw: string,
): { ok: true; origin: string } | { ok: false; reason: string } {
	const validated = validateWebhookUrl(raw.trim());
	if (!validated.ok) {
		return { ok: false, reason: validated.reason.replace('webhook', 'Kaneo') };
	}
	return { ok: true, origin: validated.url.origin };
}

/** The Kaneo web URL of a task (what Kaneo's own webhook payload links to). */
export function kaneoTaskUrl(
	origin: string,
	workspaceId: string,
	projectId: string,
	taskId: string,
): string {
	return `${origin}/dashboard/workspace/${encodeURIComponent(workspaceId)}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`;
}

/** Ticket id shown in Kaneo, e.g. `SNT-12`. Null when the task has no number. */
export function kaneoTicketKey(projectSlug: string, number: number | null): string | null {
	return number === null || number === undefined ? null : `${projectSlug}-${number}`;
}

function statusCode(status: number): KaneoErrorCode {
	if (status === 401) return 'unauthorized';
	if (status === 403) return 'forbidden';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status >= 500) return 'server_error';
	return 'bad_request';
}

export function createKaneoClient(
	origin: string,
	credentials: KaneoCredentials,
	fetcher?: typeof fetch,
) {
	const send = fetcher ?? fetch;
	const normalized = normalizeKaneoBaseUrl(origin);
	if (!normalized.ok) {
		throw new KaneoError('invalid_url', normalized.reason);
	}
	const apiBase = `${normalized.origin}/api`;

	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: `Bearer ${credentials.apiKey}`,
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';

		let response: Response;
		try {
			response = await send(`${apiBase}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				// An Access login page answers with a redirect; following it would
				// hand back HTML from another host instead of a clear error.
				redirect: 'manual',
				signal: AbortSignal.timeout(KANEO_TIMEOUT_MS),
			});
		} catch (error) {
			const timedOut = error instanceof Error && error.name === 'TimeoutError';
			throw new KaneoError(
				'unreachable',
				timedOut ? 'Kaneo did not answer within 10 seconds' : 'Kaneo could not be reached',
			);
		}

		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new KaneoError(
				'access_denied',
				'Kaneo is behind Cloudflare Access: reach it through the KANEO service binding',
				response.status,
			);
		}

		const contentType = response.headers.get('Content-Type') ?? '';
		const isJson = contentType.includes('application/json');

		if (!response.ok) {
			let detail = '';
			if (isJson) {
				const parsed = (await response.json().catch(() => null)) as {
					message?: unknown;
				} | null;
				if (parsed && typeof parsed.message === 'string') {
					detail = parsed.message.slice(0, MAX_ERROR_MESSAGE);
				}
			} else {
				await response.body?.cancel();
				if (response.status === 401 || response.status === 403) {
					// Access answers with its own HTML page, Kaneo with JSON.
					throw new KaneoError(
						'access_denied',
						'Kaneo is behind Cloudflare Access: reach it through the KANEO service binding',
						response.status,
					);
				}
			}
			throw new KaneoError(
				statusCode(response.status),
				`Kaneo answered ${response.status}${detail ? `: ${detail}` : ''}`,
				response.status,
			);
		}

		if (!isJson) {
			await response.body?.cancel();
			throw new KaneoError('bad_response', 'Kaneo answered with something other than JSON');
		}
		return (await response.json()) as T;
	}

	return {
		origin: normalized.origin,

		listWorkspaces: () => call<KaneoWorkspace[]>('GET', '/workspace'),

		listProjects: (workspaceId: string) =>
			call<KaneoProject[]>('GET', `/project?workspaceId=${encodeURIComponent(workspaceId)}`),

		getProject: (projectId: string) =>
			call<KaneoProject>('GET', `/project/${encodeURIComponent(projectId)}`),

		listColumns: (projectId: string) =>
			call<KaneoColumn[]>('GET', `/column/${encodeURIComponent(projectId)}`),

		createTask: (
			projectId: string,
			task: { title: string; description: string; priority: KaneoPriority; status: string },
		) => call<KaneoTask>('POST', `/task/${encodeURIComponent(projectId)}`, task),

		getTask: (taskId: string) => call<KaneoTask>('GET', `/task/${encodeURIComponent(taskId)}`),

		deleteTask: (taskId: string) => call<unknown>('DELETE', `/task/${encodeURIComponent(taskId)}`),

		setStatus: (taskId: string, status: string) =>
			call<KaneoTask>('PUT', `/task/status/${encodeURIComponent(taskId)}`, { status }),

		addComment: (taskId: string, content: string) =>
			call<unknown>('POST', `/comment/${encodeURIComponent(taskId)}`, { content }),

		addExternalLink: (taskId: string, link: { url: string; title: string }) =>
			call<unknown>('POST', `/external-link/task/${encodeURIComponent(taskId)}`, {
				...link,
				resourceType: 'url',
			}),

		createLabel: (label: { name: string; color: string; workspaceId: string; taskId: string }) =>
			call<unknown>('POST', '/label', label),

		getWebhook: (projectId: string) =>
			call<{ id: string } | null>(
				'GET',
				`/generic-webhook-integration/project/${encodeURIComponent(projectId)}`,
			),

		createWebhook: (projectId: string, config: KaneoWebhookConfig) =>
			call<unknown>(
				'POST',
				`/generic-webhook-integration/project/${encodeURIComponent(projectId)}`,
				config,
			),

		updateWebhook: (projectId: string, config: KaneoWebhookConfig) =>
			call<unknown>(
				'PATCH',
				`/generic-webhook-integration/project/${encodeURIComponent(projectId)}`,
				config,
			),

		deleteWebhook: (projectId: string) =>
			call<unknown>(
				'DELETE',
				`/generic-webhook-integration/project/${encodeURIComponent(projectId)}`,
			),
	};
}

export type KaneoClient = ReturnType<typeof createKaneoClient>;
