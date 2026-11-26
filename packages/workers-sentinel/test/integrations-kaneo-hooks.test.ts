import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyHexSignature } from '../src/routes/hooks';
import { FAKE_KANEO, fakeKaneo, installFakeKaneo } from './kaneo-fake';
import { fakeSlack, installFakeSlack, SLACK_TOKEN } from './slack-fake';
import {
	authFetch,
	createTestProject,
	createTestUser,
	sendTestEvent,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';

beforeEach(() => installFakeKaneo());
afterEach(() => vi.restoreAllMocks());

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
	);
	return [...signature].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('webhook signatures', () => {
	it('accepts the right HMAC and refuses anything else', async () => {
		const body = new TextEncoder().encode('{"event":"task.status_changed"}');
		const good = await hmacHex('s3cret', '{"event":"task.status_changed"}');
		expect(await verifyHexSignature('s3cret', body, good)).toBe(true);
		expect(await verifyHexSignature('s3cret', body, good.toUpperCase())).toBe(true);
		expect(await verifyHexSignature('other', body, good)).toBe(false);
		const flipped = `${good.slice(0, 63)}${good[63] === '0' ? '1' : '0'}`;
		expect(await verifyHexSignature('s3cret', body, flipped)).toBe(false);
		expect(await verifyHexSignature('s3cret', body, 'nothex')).toBe(false);
	});
});

describe('Kaneo → Sentinel webhook', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const stub = () => env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
	const settingsUrl = () => `${BASE}/api/projects/${project.slug}/integrations/kaneo`;
	const hookUrl = () => `${BASE}/api/hooks/kaneo/${project.id}`;

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `kh-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Hook Owner',
		});
		project = await createTestProject(owner.token!, { name: `Kaneo Hooks ${suffix}` });
	});

	async function connect(extra: Record<string, unknown> = {}) {
		const response = await authFetch(owner.token!, settingsUrl(), {
			method: 'PUT',
			body: JSON.stringify({
				baseUrl: FAKE_KANEO,
				apiKey: fakeKaneo.validKey,
				kaneoProjectId: 'kp1',
				...extra,
			}),
		});
		return response;
	}

	async function linkedIssue() {
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: { type: 'Error', value: `Hook boom ${Math.random()}` },
		});
		const list = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues?status=`,
		);
		const [issue] = ((await list.json()) as { issues: { id: string }[] }).issues;
		const created = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issue.id}/links/kaneo`,
			{ method: 'POST', body: '{}' },
		);
		const { link } = (await created.json()) as { link: { externalId: string } };
		return { issueId: issue.id, taskId: link.externalId };
	}

	async function deliver(payload: Record<string, unknown>, secret = fakeKaneo.webhook!.secret) {
		const body = JSON.stringify(payload);
		return SELF.fetch(hookUrl(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Kaneo-Signature': await hmacHex(secret, body),
			},
			body,
		});
	}

	function statusChanged(taskId: string, oldStatus: string, newStatus: string) {
		return {
			event: 'task.status_changed',
			task: { id: taskId, status: newStatus },
			actor: { id: 'u1', name: 'Adriano' },
			data: { oldStatus, newStatus },
		};
	}

	async function issueStatus(issueId: string) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issueId}`,
		);
		return ((await response.json()) as { issue: { status: string } }).issue.status;
	}

	async function outboxCount() {
		return runInDurableObject(
			stub(),
			async (_instance, state) =>
				state.storage.sql.exec('SELECT COUNT(*) AS n FROM integration_outbox').one().n as number,
		);
	}

	it('installs a signed webhook for status changes and deletions when connecting', async () => {
		const response = await connect();
		expect(response.status).toBe(201);
		const { integration } = (await response.json()) as { integration: Record<string, unknown> };
		expect(integration.webhookStatus).toBe('installed');
		expect(fakeKaneo.webhook?.webhookUrl).toBe(`${BASE}/api/hooks/kaneo/${project.id}`);
		expect(fakeKaneo.webhook?.secret).toMatch(/^[0-9a-f]{64}$/);
		const enabled = Object.entries(fakeKaneo.webhook!.events)
			.filter(([, on]) => on)
			.map(([key]) => key);
		expect(enabled.sort()).toEqual(['taskDeleted', 'taskStatusChanged']);

		// Saving again keeps the same secret (in-flight deliveries stay valid)
		const secret = fakeKaneo.webhook!.secret;
		await connect({ autoCreate: true });
		expect(fakeKaneo.webhook!.secret).toBe(secret);
	});

	it('leaves a webhook it did not install alone, and still saves', async () => {
		fakeKaneo.webhook = { webhookUrl: 'https://elsewhere.example/hook', secret: 'x', events: {} };
		const response = await connect();
		expect(response.status).toBe(201);
		const { integration } = (await response.json()) as {
			integration: { webhookStatus: string; webhookError: string };
		};
		expect(integration.webhookStatus).toBe('in_use');
		expect(integration.webhookError).toContain('already has a webhook');
		expect(fakeKaneo.webhook.webhookUrl).toBe('https://elsewhere.example/hook');
	});

	it('reports a webhook Kaneo refused without blocking the connection', async () => {
		fakeKaneo.denyWebhooks = true;
		const response = await connect();
		expect(response.status).toBe(201);
		const { integration } = (await response.json()) as {
			integration: { webhookStatus: string; webhookError: string };
		};
		expect(integration.webhookStatus).toBe('failed');
		expect(integration.webhookError).toContain('403');
	});

	it('removes its webhook when disconnecting', async () => {
		await connect();
		expect(fakeKaneo.webhook).not.toBeNull();
		await authFetch(owner.token!, settingsUrl(), { method: 'DELETE' });
		expect(fakeKaneo.webhook).toBeNull();
	});

	it('resolves and reopens issues when their task moves in Kaneo, without echoing back', async () => {
		await connect();
		const { issueId, taskId } = await linkedIssue();
		fakeKaneo.requests = [];

		const resolved = await deliver(statusChanged(taskId, 'to-do', 'done'));
		expect(resolved.status).toBe(200);
		expect(await resolved.json()).toEqual({ issueId, status: 'resolved' });
		expect(await issueStatus(issueId)).toBe('resolved');
		// Not sent back to Kaneo
		expect(await outboxCount()).toBe(0);

		const activity = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issueId}/activity`,
		);
		const entry = (
			(await activity.json()) as {
				activity: { userName: string; userId: string; data: Record<string, string> }[];
			}
		).activity.find((row) => row.data.to === 'resolved');
		expect(entry).toMatchObject({ userId: 'kaneo', userName: 'Kaneo · Adriano' });
		expect(entry?.data.via).toBe('kaneo');

		// Moving between open columns changes nothing
		const moved = await deliver(statusChanged(taskId, 'backlog', 'in-progress'));
		expect(await moved.json()).toMatchObject({ ignored: 'no_change' });

		const reopened = await deliver(statusChanged(taskId, 'done', 'to-do'));
		expect(await reopened.json()).toEqual({ issueId, status: 'unresolved' });
		expect(await issueStatus(issueId)).toBe('unresolved');
		expect(await outboxCount()).toBe(0);
		expect(fakeKaneo.requests.filter((r) => r.method !== 'GET')).toEqual([]);
	});

	it('ends the loop when Kaneo echoes a change Sentinel made', async () => {
		await connect();
		const { issueId, taskId } = await linkedIssue();
		await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/issues/${issueId}`, {
			method: 'PATCH',
			body: JSON.stringify({ status: 'resolved' }),
		});
		await runDurableObjectAlarm(stub());
		expect(fakeKaneo.tasks.get(taskId)!.status).toBe('done');

		// Kaneo now reports that move; the issue is already resolved
		const echo = await deliver(statusChanged(taskId, 'to-do', 'done'));
		expect(await echo.json()).toMatchObject({ ignored: 'no_change' });
		expect(await outboxCount()).toBe(0);
	});

	it('forgets the link when the task is deleted in Kaneo', async () => {
		await connect();
		const { issueId, taskId } = await linkedIssue();
		const response = await deliver({ event: 'task.deleted', task: { id: taskId } });
		expect(await response.json()).toEqual({ issueId, unlinked: true });
		const detail = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issueId}`,
		);
		expect(((await detail.json()) as { links: unknown[] }).links).toEqual([]);
	});

	it('ignores unknown tasks and other events', async () => {
		await connect();
		const unknown = await deliver(statusChanged('task-404', 'to-do', 'done'));
		expect(await unknown.json()).toMatchObject({ ignored: 'unknown_task' });
		const other = await deliver({ event: 'task.priority_changed', task: { id: 'task-1' } });
		expect(other.status).toBe(204);
	});

	it('refuses unsigned, wrongly signed, unknown-project and oversized deliveries alike', async () => {
		await connect();
		const { issueId, taskId } = await linkedIssue();
		const payload = statusChanged(taskId, 'to-do', 'done');

		const unsigned = await SELF.fetch(hookUrl(), { method: 'POST', body: JSON.stringify(payload) });
		expect(unsigned.status).toBe(401);
		const wrong = await deliver(payload, 'not-the-secret');
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: 'invalid_signature' });

		const body = JSON.stringify(payload);
		const signature = await hmacHex(fakeKaneo.webhook!.secret, body);
		const otherProject = await SELF.fetch(`${BASE}/api/hooks/kaneo/${crypto.randomUUID()}`, {
			method: 'POST',
			headers: { 'X-Kaneo-Signature': signature },
			body,
		});
		expect(otherProject.status).toBe(401);
		const notUuid = await SELF.fetch(`${BASE}/api/hooks/kaneo/not-a-project`, {
			method: 'POST',
			headers: { 'X-Kaneo-Signature': signature },
			body,
		});
		expect(notUuid.status).toBe(401);

		const huge = 'x'.repeat(70 * 1024);
		const oversized = await SELF.fetch(hookUrl(), {
			method: 'POST',
			headers: { 'X-Kaneo-Signature': await hmacHex(fakeKaneo.webhook!.secret, huge) },
			body: huge,
		});
		expect(oversized.status).toBe(413);

		expect(await issueStatus(issueId)).toBe('unresolved');
	});

	it('stops accepting deliveries once disconnected', async () => {
		await connect();
		const { taskId } = await linkedIssue();
		const secret = fakeKaneo.webhook!.secret;
		await authFetch(owner.token!, settingsUrl(), { method: 'DELETE' });
		const response = await deliver(statusChanged(taskId, 'to-do', 'done'), secret);
		expect(response.status).toBe(401);
	});

	it('tells Slack when a task closed in Kaneo resolves its issue', async () => {
		installFakeSlack();
		await connect();
		const slack = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack`,
			{ method: 'PUT', body: JSON.stringify({ botToken: SLACK_TOKEN, channelId: 'C0ERRORS' }) },
		);
		expect(slack.status).toBe(201);
		const { issueId, taskId } = await linkedIssue();
		await runDurableObjectAlarm(stub());
		const [message] = fakeSlack.posts();
		expect(message).toBeDefined();
		fakeKaneo.requests = [];

		const resolved = await deliver(statusChanged(taskId, 'to-do', 'done'));
		expect(await resolved.json()).toEqual({ issueId, status: 'resolved' });
		await runDurableObjectAlarm(stub());
		expect(message.edits.at(-1)?.text).toMatch(/^Resolved in /);
		// Still never sent back to Kaneo
		expect(fakeKaneo.requests.filter((r) => r.method !== 'GET')).toEqual([]);
	});

	it('does not create Durable Objects for made-up project ids', async () => {
		const id = crypto.randomUUID();
		const body = '{}';
		await SELF.fetch(`${BASE}/api/hooks/kaneo/${id}`, {
			method: 'POST',
			headers: { 'X-Kaneo-Signature': await hmacHex('whatever', body) },
			body,
		});
		const tables = await runInDurableObject(
			env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(id)),
			async (_instance, state) =>
				state.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issues'")
					.toArray().length,
		);
		expect(tables).toBe(0);
	});
});
