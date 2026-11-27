import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_KANEO, fakeKaneo, installFakeKaneo } from './kaneo-fake';
import { fakeSlack, installFakeSlack, SLACK_TOKEN } from './slack-fake';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	sendTestEvent,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';

beforeEach(() => {
	installFakeKaneo();
	installFakeSlack();
});
afterEach(() => vi.restoreAllMocks());

describe('Slack messages for issues', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const stub = () => env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `sm-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Slack Msg Owner',
		});
		member = await createTestUser({
			email: `sm-member-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Slack Msg Member',
		});
		project = await createTestProject(owner.token!, { name: `Slack Messages ${suffix}` });
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	// Every test posts to the same fake channel, and a delivery retry left by
	// one test's project fires on real time (its Durable Object alarm), so it
	// could land in a later test's assertions. Disconnecting drops the
	// project's pending deliveries.
	afterEach(async () => {
		if (!project) return;
		await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/integrations/slack`, {
			method: 'DELETE',
		}).catch(() => {});
	});

	async function connect(extra: Record<string, unknown> = {}) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack`,
			{
				method: 'PUT',
				body: JSON.stringify({ botToken: SLACK_TOKEN, channelId: 'C0ERRORS', ...extra }),
			},
		);
		expect(response.status).toBe(201);
		fakeSlack.requests = [];
	}

	async function sendError(message = 'Boom', extra: Record<string, unknown> = {}) {
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: {
				type: 'Error',
				value: message,
				stacktrace: { frames: [{ filename: 'app.js', function: 'run', lineno: 7, in_app: true }] },
			},
			user: { email: 'secret-user@example.com' },
			...extra,
		});
	}

	async function issues() {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues?status=`,
		);
		return ((await response.json()) as { issues: { id: string; title: string; status: string }[] })
			.issues;
	}

	async function issueDetail(id: string) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${id}`,
		);
		return (await response.json()) as {
			issue: { status: string };
			links: { type: string; externalKey: string; externalUrl: string; externalId: string }[];
			availableIntegrations: string[];
		};
	}

	async function setStatus(id: string, status: string) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${id}`,
			{ method: 'PATCH', body: JSON.stringify({ status }) },
		);
		expect(response.status).toBe(200);
	}

	async function outbox() {
		return runInDurableObject(stub(), async (_instance, state) =>
			state.storage.sql.exec('SELECT * FROM integration_outbox ORDER BY created_at').toArray(),
		);
	}

	async function makeDue() {
		await runInDurableObject(stub(), async (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE integration_outbox SET next_attempt_at = ?',
				new Date(Date.now() - 1000).toISOString(),
			);
			await state.storage.setAlarm(Date.now() + 1000);
		});
	}

	it('posts one message per new issue that matches the filters', async () => {
		await connect({ minLevel: 'error', environments: ['production'] });

		await sendError('Prod boom', { environment: 'production' });
		await sendTestEvent(project.id, project.publicKey, {
			level: 'warning',
			message: 'Just a warning',
			environment: 'production',
		});
		await sendError('Staging boom', { environment: 'staging' });
		expect((await outbox()).map((row) => row.action)).toEqual(['create']);

		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		expect(fakeSlack.posts()).toHaveLength(1);
		const [message] = fakeSlack.posts();
		expect(message.channel).toBe('C0ERRORS');
		expect(message.text).toContain('Error: Prod boom');
		expect(JSON.stringify(message.blocks)).not.toContain('secret-user@example.com');

		const prod = (await issues()).find((i) => i.title === 'Error: Prod boom')!;
		const detail = await issueDetail(prod.id);
		expect(detail.availableIntegrations).toEqual(['slack']);
		expect(detail.links).toEqual([
			expect.objectContaining({
				type: 'slack',
				externalKey: '#errors',
				externalId: `C0ERRORS:${message.ts}`,
				externalUrl: expect.stringContaining('https://acme.slack.com/archives/C0ERRORS/'),
			}),
		]);

		// More events of the same issue never post again
		await sendError('Prod boom', { environment: 'production' });
		expect(await outbox()).toEqual([]);
	});

	it('delivers nothing while only the bot token is saved (pending)', async () => {
		const pending = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack`,
			{ method: 'PUT', body: JSON.stringify({ botToken: SLACK_TOKEN }) },
		);
		expect(pending.status).toBe(201);
		expect(((await pending.json()) as { integration: unknown }).integration).toMatchObject({
			status: 'pending',
			channelId: '',
			teamName: 'Acme',
		});
		fakeSlack.requests = [];

		await sendError('Too early');
		expect(await outbox()).toEqual([]);
		const early = (await issues()).find((i) => i.title === 'Error: Too early')!;
		expect((await issueDetail(early.id)).availableIntegrations).toEqual([]);

		const test = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack/test`,
			{ method: 'POST' },
		);
		expect(test.status).toBe(409);
		expect(fakeSlack.posts()).toHaveLength(0);

		// Choosing the channel (no token in the body) turns it on.
		const connected = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack`,
			{ method: 'PUT', body: JSON.stringify({ channelId: 'C0ERRORS' }) },
		);
		expect(connected.status).toBe(200);
		await sendError('Now it counts');
		expect((await outbox()).map((row) => row.action)).toEqual(['create']);
	});

	it('marks the message resolved, and back, following the issue status', async () => {
		await connect();
		await sendError('Sync boom');
		await runDurableObjectAlarm(stub());
		const [issue] = await issues();
		const [message] = fakeSlack.posts();

		await setStatus(issue.id, 'resolved');
		await runDurableObjectAlarm(stub());
		expect(message.edits.at(-1)?.text).toMatch(/^Resolved in /);

		await setStatus(issue.id, 'unresolved');
		await runDurableObjectAlarm(stub());
		expect(message.edits.at(-1)?.text).toMatch(/^New error in /);
		expect(fakeSlack.replies(message.ts)).toEqual([]);

		await setStatus(issue.id, 'ignored');
		expect(await outbox()).toEqual([]);
	});

	it('replies in the thread when a resolved issue comes back', async () => {
		await connect();
		await sendError('Regression boom');
		await runDurableObjectAlarm(stub());
		const [issue] = await issues();
		const [message] = fakeSlack.posts();
		await setStatus(issue.id, 'resolved');
		await runDurableObjectAlarm(stub());

		await sendError('Regression boom');
		expect((await issueDetail(issue.id)).issue.status).toBe('unresolved');
		await runDurableObjectAlarm(stub());

		expect(fakeSlack.posts()).toHaveLength(1);
		const replies = fakeSlack.replies(message.ts);
		expect(replies).toHaveLength(1);
		expect(replies[0].text).toContain('came back');
		expect(message.edits.at(-1)?.text).toMatch(/^Came back in /);
	});

	it('stays quiet about resolutions and regressions when told to', async () => {
		await connect({ notifyRegression: false, notifyResolved: false });
		await sendError('Quiet boom');
		await runDurableObjectAlarm(stub());
		const [issue] = await issues();

		await setStatus(issue.id, 'resolved');
		expect(await outbox()).toEqual([]);
		await sendError('Quiet boom');
		expect(await outbox()).toEqual([]);
	});

	it('posts on demand from the issue page, once, for any member', async () => {
		await connect({ minLevel: 'fatal' });
		await sendError('Manual boom');
		expect(await outbox()).toEqual([]);
		const [issue] = await issues();
		const link = `${BASE}/api/projects/${project.slug}/issues/${issue.id}/links/slack`;

		const first = await authFetch(member.token!, link, { method: 'POST', body: '{}' });
		expect(first.status).toBe(201);
		const again = await authFetch(member.token!, link, { method: 'POST', body: '{}' });
		expect(again.status).toBe(200);
		expect(fakeSlack.posts()).toHaveLength(1);
	});

	it('waits out Slack rate limits without counting an attempt', async () => {
		await connect();
		fakeSlack.rateLimitOnce = true;
		await sendError('Busy boom');
		await runDurableObjectAlarm(stub());
		const [row] = await outbox();
		expect(row.attempts).toBe(0);
		const wait = new Date(row.next_attempt_at as string).getTime() - Date.now();
		expect(wait).toBeGreaterThan(5_000);
		expect(wait).toBeLessThanOrEqual(7_000);

		await makeDue();
		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		expect(fakeSlack.posts()).toHaveLength(1);
	});

	it('gives up after the retries and records why', async () => {
		await connect();
		fakeSlack.failPosts = 'not_in_channel';
		await sendError('Kicked boom');
		for (let attempt = 1; attempt <= 3; attempt++) {
			await runDurableObjectAlarm(stub());
			expect((await outbox())[0].attempts).toBe(attempt);
			await makeDue();
		}
		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);

		const settings = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/slack`,
		);
		const { integration } = (await settings.json()) as { integration: { lastError: string } };
		expect(integration.lastError).toContain('Could not post the Slack message');
		expect(integration.lastError).toContain('/invite');
	});

	it('runs alongside Kaneo without either getting in the way', async () => {
		await connect();
		const kaneo = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/kaneo`,
			{
				method: 'PUT',
				body: JSON.stringify({
					baseUrl: FAKE_KANEO,
					apiKey: fakeKaneo.validKey,
					kaneoProjectId: 'kp1',
					autoCreate: true,
				}),
			},
		);
		expect(kaneo.status).toBe(201);

		await sendError('Both boom');
		expect((await outbox()).map((row) => row.action)).toEqual(['create', 'create']);
		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		expect(fakeSlack.posts()).toHaveLength(1);
		expect(fakeKaneo.tasks.size).toBe(1);

		const [issue] = await issues();
		const detail = await issueDetail(issue.id);
		expect(detail.availableIntegrations).toEqual(['kaneo', 'slack']);
		expect(detail.links.map((l) => l.type).sort()).toEqual(['kaneo', 'slack']);

		// Slack down: Kaneo still gets its update
		fakeSlack.failPosts = 'internal_error';
		await setStatus(issue.id, 'resolved');
		await runDurableObjectAlarm(stub());
		expect([...fakeKaneo.tasks.values()][0].status).toBe('done');
		expect((await outbox()).map((row) => row.attempts)).toEqual([1]);
	});

	it('drops pending deliveries when Slack is disconnected', async () => {
		await connect();
		await sendError('Disconnect boom');
		expect(await outbox()).toHaveLength(1);
		await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/integrations/slack`, {
			method: 'DELETE',
		});
		expect(await outbox()).toEqual([]);
	});
});
