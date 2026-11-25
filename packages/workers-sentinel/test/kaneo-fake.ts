/**
 * A fake Kaneo API behind globalThis.fetch. The tests, the worker and its
 * Durable Objects share one isolate, so spying on fetch intercepts the
 * worker's real outbound calls. Only FAKE_KANEO URLs are intercepted.
 */
import { vi } from 'vitest';

export const FAKE_KANEO = 'https://kaneo.test.example';

export interface FakeRequest {
	method: string;
	path: string;
	headers: Headers;
	body: unknown;
}

export interface FakeTask {
	id: string;
	projectId: string;
	number: number;
	title: string;
	description: string;
	priority: string;
	status: string;
	comments: string[];
	links: { url: string; title: string }[];
	labels: string[];
}

export const FAKE_COLUMNS = [
	{ id: 'c1', name: 'Backlog', slug: 'backlog', position: 0, isFinal: false },
	{ id: 'c2', name: 'To Do', slug: 'to-do', position: 1, isFinal: false },
	{ id: 'c3', name: 'In Progress', slug: 'in-progress', position: 2, isFinal: false },
	{ id: 'c4', name: 'Done', slug: 'done', position: 3, isFinal: true },
];

export const fakeKaneo = {
	requests: [] as FakeRequest[],
	tasks: new Map<string, FakeTask>(),
	validKey: 'kaneo-api-key-123456789',
	requireAccess: false,
	/** Make every task-writing call answer 500 (outage simulation). */
	failWrites: false,
	nextNumber: 1,
	/** The project's generic webhook (Kaneo allows one per project). */
	webhook: null as null | { webhookUrl: string; secret: string; events: Record<string, boolean> },
	/** Make the webhook endpoints answer 403 (API key without that permission). */
	denyWebhooks: false,

	reset() {
		this.requests = [];
		this.tasks = new Map();
		this.validKey = 'kaneo-api-key-123456789';
		this.requireAccess = false;
		this.failWrites = false;
		this.nextNumber = 1;
		this.webhook = null;
		this.denyWebhooks = false;
	},

	calls(method: string, prefix: string) {
		return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
	},
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function handle(url: URL, init: RequestInit = {}): Promise<Response> {
	const method = (init.method ?? 'GET').toUpperCase();
	const headers = new Headers(init.headers);
	const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
	const path = url.pathname.replace(/^\/api/, '') + url.search;
	fakeKaneo.requests.push({ method, path, headers, body });

	if (fakeKaneo.requireAccess && headers.get('CF-Access-Client-Id') !== 'access-id') {
		return new Response(null, { status: 302, headers: { Location: 'https://team.example/login' } });
	}
	if (headers.get('Authorization') !== `Bearer ${fakeKaneo.validKey}`) {
		return json({ message: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
	}
	if (fakeKaneo.failWrites && method !== 'GET') {
		return json({ message: 'Internal error' }, 500);
	}

	if (method === 'GET' && path === '/workspace') {
		return json([{ id: 'ws1', name: 'Personal', slug: 'personal', role: 'owner' }]);
	}
	if (method === 'GET' && path === '/project?workspaceId=ws1') {
		return json([{ id: 'kp1', name: 'Sentinel', slug: 'SNT', workspaceId: 'ws1' }]);
	}
	if (method === 'GET' && path === '/project/kp1') {
		return json({ id: 'kp1', name: 'Sentinel', slug: 'SNT', workspaceId: 'ws1' });
	}
	if (method === 'GET' && path === '/column/kp1') {
		return json(FAKE_COLUMNS);
	}

	let match = /^\/task\/(kp1)$/.exec(path);
	if (method === 'POST' && match) {
		const input = body as { title: string; description: string; priority: string; status: string };
		if (!FAKE_COLUMNS.some((col) => col.slug === input.status)) {
			return json({ message: 'Unknown column' }, 400);
		}
		const task: FakeTask = {
			id: `task-${fakeKaneo.nextNumber}`,
			projectId: 'kp1',
			number: fakeKaneo.nextNumber++,
			title: input.title,
			description: input.description,
			priority: input.priority,
			status: input.status,
			comments: [],
			links: [],
			labels: [],
		};
		fakeKaneo.tasks.set(task.id, task);
		return json(task);
	}
	match = /^\/task\/status\/([^/]+)$/.exec(path);
	if (method === 'PUT' && match) {
		const task = fakeKaneo.tasks.get(match[1]);
		if (!task) return json({ message: 'Task not found' }, 404);
		task.status = (body as { status: string }).status;
		return json(task);
	}
	match = /^\/comment\/([^/]+)$/.exec(path);
	if (method === 'POST' && match) {
		const task = fakeKaneo.tasks.get(match[1]);
		if (!task) return json({ message: 'Task not found' }, 404);
		task.comments.push((body as { content: string }).content);
		return json({ id: `comment-${task.comments.length}` });
	}
	match = /^\/external-link\/task\/([^/]+)$/.exec(path);
	if (method === 'POST' && match) {
		const task = fakeKaneo.tasks.get(match[1]);
		if (!task) return json({ message: 'Task not found' }, 404);
		task.links.push(body as { url: string; title: string });
		return json({ id: 'link-1' });
	}
	if (path === '/generic-webhook-integration/project/kp1') {
		if (fakeKaneo.denyWebhooks) return json({ message: 'Forbidden' }, 403);
		if (method === 'GET') {
			return json(
				fakeKaneo.webhook ? { id: 'wh1', projectId: 'kp1', webhookConfigured: true } : null,
			);
		}
		if (method === 'POST') {
			if (fakeKaneo.webhook) return json({ message: 'Webhook already exists' }, 409);
			fakeKaneo.webhook = body as typeof fakeKaneo.webhook;
			return json({ id: 'wh1' });
		}
		if (method === 'PATCH') {
			if (!fakeKaneo.webhook) return json({ message: 'Not found' }, 404);
			fakeKaneo.webhook = { ...fakeKaneo.webhook, ...(body as object) } as typeof fakeKaneo.webhook;
			return json({ id: 'wh1' });
		}
		if (method === 'DELETE') {
			fakeKaneo.webhook = null;
			return json({ success: true });
		}
	}
	if (method === 'POST' && path === '/label') {
		const input = body as { name: string; taskId: string };
		fakeKaneo.tasks.get(input.taskId)?.labels.push(input.name);
		return json({ id: 'label-1' });
	}
	return json({ message: 'Not found' }, 404);
}

/** Install the fake (call in beforeEach; vi.restoreAllMocks in afterEach). */
export function installFakeKaneo(): void {
	fakeKaneo.reset();
	const originalFetch = globalThis.fetch;
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin === FAKE_KANEO) return handle(url, init);
		return originalFetch(input, init);
	});
}
