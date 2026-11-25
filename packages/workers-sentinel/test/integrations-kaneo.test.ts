import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKaneoClient, KaneoError, normalizeKaneoBaseUrl } from '../src/lib/kaneo';
import { maskSecret, openSecret, SecretBoxError, sealSecret } from '../src/lib/secret-box';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';
const KANEO = 'https://kaneo.test.example';
const KEY = 'test-integrations-key-0123456789abcdef';

// ---------------------------------------------------------------------------
// A fake Kaneo API behind globalThis.fetch (the worker, its Durable Objects
// and the tests share one isolate). Only KANEO URLs are intercepted.
// ---------------------------------------------------------------------------

interface FakeRequest {
	method: string;
	path: string;
	headers: Headers;
	body: unknown;
}

const COLUMNS = [
	{ id: 'c1', name: 'Backlog', slug: 'backlog', position: 0, isFinal: false },
	{ id: 'c2', name: 'To Do', slug: 'to-do', position: 1, isFinal: false },
	{ id: 'c3', name: 'In Progress', slug: 'in-progress', position: 2, isFinal: false },
	{ id: 'c4', name: 'Done', slug: 'done', position: 3, isFinal: true },
];

let requests: FakeRequest[] = [];
let validKey = 'kaneo-api-key-123456789';
let requireAccess = false;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function fakeKaneo(url: URL, init: RequestInit = {}): Promise<Response> {
	const method = (init.method ?? 'GET').toUpperCase();
	const headers = new Headers(init.headers);
	const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
	const path = url.pathname.replace(/^\/api/, '') + url.search;
	requests.push({ method, path, headers, body });

	if (requireAccess && headers.get('CF-Access-Client-Id') !== 'access-id') {
		// Cloudflare Access answers with its login redirect
		return new Response(null, { status: 302, headers: { Location: 'https://team.example/login' } });
	}
	if (headers.get('Authorization') !== `Bearer ${validKey}`) {
		return json({ message: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
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
		return json(COLUMNS);
	}
	return json({ message: 'Not found' }, 404);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
	requests = [];
	validKey = 'kaneo-api-key-123456789';
	requireAccess = false;
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin === KANEO) return fakeKaneo(url, init);
		return originalFetch(input, init);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('secret-box', () => {
	it('round-trips and binds the ciphertext to its project', async () => {
		const sealed = await sealSecret(KEY, 'project-a', 'hello');
		expect(sealed).toMatch(/^v1\./);
		expect(sealed).not.toContain('hello');
		expect(await openSecret(KEY, 'project-a', sealed)).toBe('hello');
		await expect(openSecret(KEY, 'project-b', sealed)).rejects.toBeInstanceOf(SecretBoxError);
		await expect(openSecret(`${KEY}-other`, 'project-a', sealed)).rejects.toBeInstanceOf(
			SecretBoxError,
		);
	});

	it('uses a fresh IV every time', async () => {
		const a = await sealSecret(KEY, 'p', 'same');
		const b = await sealSecret(KEY, 'p', 'same');
		expect(a).not.toBe(b);
	});

	it('refuses a short master key', async () => {
		await expect(sealSecret('short', 'p', 'x')).rejects.toBeInstanceOf(SecretBoxError);
	});

	it('masks secrets for display', () => {
		expect(maskSecret('abcdefghijklmnopqrstuvwxyz')).toBe('abcd…wxyz');
		expect(maskSecret('short')).toBe('••••');
		expect(maskSecret(null)).toBeNull();
	});
});

describe('Kaneo client', () => {
	it('normalizes the base URL to an https origin', () => {
		expect(normalizeKaneoBaseUrl('https://kaneo.example.com/api/')).toEqual({
			ok: true,
			origin: 'https://kaneo.example.com',
		});
		expect(normalizeKaneoBaseUrl('http://kaneo.example.com').ok).toBe(false);
		expect(normalizeKaneoBaseUrl('https://10.0.0.1').ok).toBe(false);
	});

	it('sends the API key and the Access service token', async () => {
		requireAccess = true;
		const client = createKaneoClient(KANEO, {
			apiKey: validKey,
			accessClientId: 'access-id',
			accessClientSecret: 'access-secret',
		});
		const columns = await client.listColumns('kp1');
		expect(columns.map((col) => col.slug)).toContain('done');
		const sent = requests.at(-1)!;
		expect(sent.headers.get('CF-Access-Client-Secret')).toBe('access-secret');
	});

	it('reports an Access redirect as access_denied', async () => {
		requireAccess = true;
		const client = createKaneoClient(KANEO, { apiKey: validKey });
		await expect(client.listWorkspaces()).rejects.toMatchObject({ code: 'access_denied' });
	});

	it('reports a bad key as unauthorized with Kaneo’s message', async () => {
		const client = createKaneoClient(KANEO, { apiKey: 'wrong' });
		const error = await client.listWorkspaces().catch((e) => e);
		expect(error).toBeInstanceOf(KaneoError);
		expect(error.code).toBe('unauthorized');
		expect(error.message).toContain('Unauthorized');
	});
});

describe('Kaneo integration config routes', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const url = () => `${BASE}/api/projects/${project.slug}/integrations/kaneo`;

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `kaneo-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Kaneo Owner',
		});
		member = await createTestUser({
			email: `kaneo-member-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Kaneo Member',
		});
		project = await createTestProject(owner.token!, { name: `Kaneo ${suffix}` });
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	async function connect(extra: Record<string, unknown> = {}) {
		return authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({
				baseUrl: `${KANEO}/api`,
				apiKey: validKey,
				kaneoProjectId: 'kp1',
				...extra,
			}),
		});
	}

	it('starts disconnected', async () => {
		const response = await authFetch(owner.token!, url());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ configured: true, integration: null });
	});

	it('discovers workspaces, projects and columns with the typed credentials', async () => {
		const response = await authFetch(owner.token!, `${url()}/discover`, {
			method: 'POST',
			body: JSON.stringify({
				baseUrl: KANEO,
				apiKey: validKey,
				workspaceId: 'ws1',
				kaneoProjectId: 'kp1',
			}),
		});
		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			workspaces: { id: string }[];
			projects: { id: string }[];
			columns: { slug: string; isFinal: boolean }[];
		};
		expect(data.workspaces.map((w) => w.id)).toEqual(['ws1']);
		expect(data.projects.map((p) => p.id)).toEqual(['kp1']);
		expect(data.columns.find((col) => col.isFinal)?.slug).toBe('done');
	});

	it('connects with default columns and never returns the key', async () => {
		const response = await connect();
		expect(response.status).toBe(201);
		const text = await response.text();
		expect(text).not.toContain(validKey);
		const { integration } = JSON.parse(text) as { integration: Record<string, unknown> };
		expect(integration).toMatchObject({
			baseUrl: KANEO,
			workspaceId: 'ws1',
			kaneoProjectId: 'kp1',
			kaneoProjectName: 'Sentinel',
			kaneoProjectSlug: 'SNT',
			createColumn: 'to-do',
			doneColumn: 'done',
			reopenColumn: 'to-do',
			autoCreate: false,
			minLevel: 'error',
			environments: [],
			apiKey: 'kane…6789',
			hasAccessToken: false,
		});

		const read = await authFetch(owner.token!, url());
		const readText = await read.text();
		expect(readText).not.toContain(validKey);
		expect(JSON.parse(readText).integration.apiKey).toBe('kane…6789');
	});

	it('stores the credentials sealed in ProjectState', async () => {
		await connect();
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const stored = (await (
			await stub.fetch('http://internal/integrations/get', {
				method: 'POST',
				body: JSON.stringify({ type: 'kaneo' }),
			})
		).json()) as { integration: { secretCipher: string } };
		expect(stored.integration.secretCipher).not.toContain(validKey);
		const opened = JSON.parse(await openSecret(KEY, project.id, stored.integration.secretCipher));
		expect(opened.apiKey).toBe(validKey);
	});

	it('keeps the stored key when an update omits it', async () => {
		await connect();
		const response = await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ autoCreate: true, minLevel: 'warning', environments: ['production'] }),
		});
		expect(response.status).toBe(200);
		const { integration } = (await response.json()) as { integration: Record<string, unknown> };
		expect(integration).toMatchObject({
			autoCreate: true,
			minLevel: 'warning',
			environments: ['production'],
			apiKey: 'kane…6789',
		});
	});

	it('rejects unknown columns and a done column equal to an open one', async () => {
		const unknown = await connect({ createColumn: 'nope' });
		expect(unknown.status).toBe(400);
		const same = await connect({ createColumn: 'done', doneColumn: 'done' });
		expect(same.status).toBe(400);
	});

	it('rejects half an Access service token', async () => {
		const response = await connect({ accessClientId: 'access-id' });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toContain('both');
	});

	it('reports Kaneo failures as 502 without storing anything', async () => {
		const response = await connect({ apiKey: 'wrong-key' });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'kaneo_failed', code: 'unauthorized' });
		const read = await authFetch(owner.token!, url());
		expect(((await read.json()) as { integration: unknown }).integration).toBeNull();
	});

	it('refuses private Kaneo hosts', async () => {
		const response = await connect({ baseUrl: 'https://192.168.1.10' });
		expect(response.status).toBe(400);
	});

	it('tests the stored connection', async () => {
		await connect();
		const ok = await authFetch(owner.token!, `${url()}/test`, { method: 'POST', body: '{}' });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ ok: true, project: { slug: 'SNT' } });

		validKey = 'rotated-on-the-kaneo-side';
		const broken = await authFetch(owner.token!, `${url()}/test`, { method: 'POST', body: '{}' });
		expect(broken.status).toBe(502);
	});

	it('is owner/admin only', async () => {
		await connect();
		const read = await authFetch(member.token!, url());
		expect(read.status).toBe(403);
		const write = await authFetch(member.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ baseUrl: KANEO, apiKey: validKey, kaneoProjectId: 'kp1' }),
		});
		expect(write.status).toBe(403);
		const remove = await authFetch(member.token!, url(), { method: 'DELETE' });
		expect(remove.status).toBe(403);
	});

	it('disconnects and audits every change', async () => {
		await connect();
		await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ apiKey: validKey.split('').reverse().join('') }),
		}).catch(() => undefined);
		await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ autoCreate: true }),
		});
		const removed = await authFetch(owner.token!, url(), { method: 'DELETE' });
		expect(removed.status).toBe(200);
		const again = await authFetch(owner.token!, url(), { method: 'DELETE' });
		expect(again.status).toBe(404);

		const audit = await adminFetch(`${BASE}/api/admin/audit?limit=100`);
		const { entries } = (await audit.json()) as {
			entries: { action: string; targetId: string; details: Record<string, unknown> }[];
		};
		const mine = entries.filter((e) => e.targetId === project.id).map((e) => e.action);
		expect(mine).toContain('integration.created');
		expect(mine).toContain('integration.updated');
		expect(mine).toContain('integration.deleted');
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain(validKey);
	});

	it('refuses audit actions outside the integration family', async () => {
		const authState = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
		const response = await authState.fetch('http://internal/audit/append', {
			method: 'POST',
			body: JSON.stringify({
				userId: owner.id,
				action: 'user.deleted',
				targetType: 'user',
			}),
		});
		expect(response.status).toBe(400);
	});
});
