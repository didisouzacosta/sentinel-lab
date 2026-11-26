import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSecret } from '../src/lib/secret-box';
import {
	checkBotToken,
	createSlackClient,
	parseSlackAppId,
	parseSlackMessageId,
	SlackError,
} from '../src/lib/slack';
import { buildSlackIssueMessage, buildSlackTestMessage } from '../src/lib/slack-message';
import { fakeSlack, installFakeSlack, SLACK_TOKEN } from './slack-fake';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';
const KEY = 'test-integrations-key-0123456789abcdef';

beforeEach(() => installFakeSlack());
afterEach(() => vi.restoreAllMocks());

describe('Slack client', () => {
	it('only takes bot tokens', () => {
		expect(checkBotToken('xoxp-user-token').ok).toBe(false);
		expect(checkBotToken(' xoxb-123 ').ok).toBe(true);
		expect(() => createSlackClient({ botToken: 'nope' })).toThrow(SlackError);
	});

	it('sends the token as a bearer and lists every page of channels', async () => {
		const client = createSlackClient({ botToken: SLACK_TOKEN });
		const { channels, truncated } = await client.listChannels();
		expect(truncated).toBe(false);
		expect(channels.map((c) => c.name)).toEqual(['errors', 'general', 'secret']);
		expect(fakeSlack.calls('conversations.list')).toHaveLength(2);
	});

	it('maps Slack errors to actionable codes', async () => {
		const bad = createSlackClient({ botToken: 'xoxb-wrong' });
		await expect(bad.authTest()).rejects.toMatchObject({ code: 'unauthorized' });

		const client = createSlackClient({ botToken: SLACK_TOKEN });
		await expect(client.postMessage('G0LOCKED', { text: 'hi' })).rejects.toMatchObject({
			code: 'not_in_channel',
		});
		fakeSlack.rateLimitOnce = true;
		await expect(client.postMessage('C0ERRORS', { text: 'hi' })).rejects.toMatchObject({
			code: 'ratelimited',
			retryAfter: 7,
		});
	});

	it('reads the App ID from an app page address or the bare id', () => {
		expect(parseSlackAppId('https://api.slack.com/apps/A08K2TX4R1Q/oauth')).toBe('A08K2TX4R1Q');
		expect(parseSlackAppId(' A08K2TX4R1Q ')).toBe('A08K2TX4R1Q');
		expect(parseSlackAppId('https://api.slack.com/apps')).toBeNull();
		expect(parseSlackAppId('xoxb-1234')).toBeNull();
	});

	it('round-trips message ids', () => {
		expect(parseSlackMessageId('C0ERRORS:1700000000.000001')).toEqual({
			channel: 'C0ERRORS',
			ts: '1700000000.000001',
		});
		expect(parseSlackMessageId('broken')).toBeNull();
	});
});

describe('Slack messages', () => {
	const issue = {
		id: 'issue-1',
		title: 'TypeError: <b>x</b> is undefined',
		culprit: 'app.js in handleClick',
		level: 'error',
		status: 'unresolved',
		count: 3,
		userCount: 2,
		firstSeen: '2026-11-25T10:00:00.000Z',
		lastSeen: '2026-11-25T11:00:00.000Z',
	};
	const context = {
		permalink: 'https://sentinel.test/projects/web/issues/issue-1',
		projectName: 'Web',
	};

	it('describes the error without personal data and escapes mrkdwn', () => {
		const message = buildSlackIssueMessage(
			issue,
			{
				environment: 'production',
				release: 'web@1.2.3',
				user: { email: 'person@example.com' },
				exception: {
					values: [
						{
							type: 'TypeError',
							value: 'x is undefined',
							stacktrace: { frames: [{ filename: 'app.js', function: 'run', in_app: true }] },
						},
					],
				},
			},
			context,
		);
		const serialized = JSON.stringify(message);
		expect(message.text).toBe('New error in Web: TypeError: &lt;b&gt;x&lt;/b&gt; is undefined');
		expect(serialized).toContain('&lt;b&gt;x&lt;/b&gt;');
		expect(serialized).toContain('production');
		expect(serialized).toContain('web@1.2.3');
		expect(serialized).toContain('[app] run (app.js)');
		expect(serialized).toContain(context.permalink);
		expect(serialized).not.toContain('person@example.com');
	});

	it('marks resolved messages', () => {
		const message = buildSlackIssueMessage(issue, null, context, 'resolved');
		expect(message.text).toMatch(/^Resolved in Web/);
		expect(JSON.stringify(message.blocks)).toContain(':white_check_mark: Resolved');
	});

	it('builds the test message', () => {
		expect(buildSlackTestMessage('Web', 'https://sentinel.test/x').text).toContain('Web');
	});
});

describe('Slack integration config routes', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const url = (path = '') => `${BASE}/api/projects/${project.slug}/integrations/slack${path}`;

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `slack-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Slack Owner',
		});
		member = await createTestUser({
			email: `slack-member-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Slack Member',
		});
		project = await createTestProject(owner.token!, { name: `Slack ${suffix}` });
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	async function connect(extra: Record<string, unknown> = {}) {
		return authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ botToken: SLACK_TOKEN, channelId: 'C0ERRORS', ...extra }),
		});
	}

	it('starts disconnected and offers the app manifest', async () => {
		const response = await authFetch(owner.token!, url());
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			configured: boolean;
			integration: unknown;
			scopes: string[];
			manifest: { oauth_config: { scopes: { bot: string[] } } };
		};
		expect(body.configured).toBe(true);
		expect(body.integration).toBeNull();
		expect(body.scopes).toContain('chat:write');
		expect(body.manifest.oauth_config.scopes.bot).toEqual(body.scopes);
	});

	it('discovers the workspace and channels with the typed token', async () => {
		const response = await authFetch(owner.token!, url('/discover'), {
			method: 'POST',
			body: JSON.stringify({ botToken: SLACK_TOKEN }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			team: { name: string };
			channels: { id: string; name: string }[];
		};
		expect(body.team.name).toBe('Acme');
		expect(body.channels.map((c) => c.id)).toEqual(['C0ERRORS', 'C0GENERAL', 'G0SECRET']);
	});

	it('refuses anything but a bot token', async () => {
		const response = await connect({ botToken: 'xoxp-user-token' });
		expect(response.status).toBe(400);
		expect(fakeSlack.requests).toHaveLength(0);
	});

	it('connects with defaults and never returns the token', async () => {
		const response = await connect();
		expect(response.status).toBe(201);
		const { integration } = (await response.json()) as { integration: Record<string, unknown> };
		expect(integration).toMatchObject({
			type: 'slack',
			enabled: true,
			teamName: 'Acme',
			channelId: 'C0ERRORS',
			channelName: 'errors',
			minLevel: 'error',
			environments: [],
			notifyRegression: true,
			notifyResolved: true,
			credentialsReadable: true,
		});
		expect(JSON.stringify(integration)).not.toContain(SLACK_TOKEN);
		expect(integration.botToken).toMatch(/…/);
	});

	it('stores the token sealed in ProjectState', async () => {
		await connect();
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
		const stored = (await (
			await stub.fetch('http://internal/integrations/get', {
				method: 'POST',
				body: JSON.stringify({ type: 'slack' }),
			})
		).json()) as { integration: { secretCipher: string } };
		expect(stored.integration.secretCipher).not.toContain(SLACK_TOKEN);
		const opened = JSON.parse(await openSecret(KEY, project.id, stored.integration.secretCipher));
		expect(opened.botToken).toBe(SLACK_TOKEN);
	});

	it('keeps the stored token and channel when an update omits them', async () => {
		await connect();
		const response = await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ minLevel: 'warning', environments: ['production'] }),
		});
		expect(response.status).toBe(200);
		const { integration } = (await response.json()) as { integration: Record<string, unknown> };
		expect(integration).toMatchObject({
			channelId: 'C0ERRORS',
			minLevel: 'warning',
			environments: ['production'],
		});
	});

	it('saves a verified token as pending with the app id, before a channel is chosen', async () => {
		const response = await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({
				botToken: SLACK_TOKEN,
				appId: 'https://api.slack.com/apps/A08K2TX4R1Q',
			}),
		});
		expect(response.status).toBe(201);
		const text = await response.text();
		expect(text).not.toContain(SLACK_TOKEN);
		expect(JSON.parse(text).integration).toMatchObject({
			status: 'pending',
			appId: 'A08K2TX4R1Q',
			teamName: 'Acme',
			channelId: '',
			botToken: 'xoxb…oken',
		});
		expect(fakeSlack.calls('conversations.info')).toHaveLength(0);

		const connected = await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ channelId: 'C0ERRORS' }),
		});
		expect(connected.status).toBe(200);
		expect(((await connected.json()) as { integration: unknown }).integration).toMatchObject({
			status: 'connected',
			appId: 'A08K2TX4R1Q',
			channelName: 'errors',
		});
	});

	it('refuses an app id that is not one', async () => {
		const response = await connect({ appId: 'https://example.com/not-slack' });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toContain('App ID');
	});

	it('finds channels by name, and refuses archived or bot-less private ones', async () => {
		const byName = await connect({ channelId: undefined, channel: '#general' });
		expect(byName.status).toBe(201);
		expect(
			((await byName.json()) as { integration: { channelId: string } }).integration.channelId,
		).toBe('C0GENERAL');

		const archived = await connect({ channelId: 'C0OLD' });
		expect(archived.status).toBe(400);
		expect(((await archived.json()) as { message: string }).message).toContain('archived');

		const locked = await connect({ channelId: 'G0LOCKED' });
		expect(locked.status).toBe(400);

		const missing = await connect({ channelId: undefined, channel: 'nope' });
		expect(missing.status).toBe(400);
	});

	it('reports a refused token as 502 without storing anything', async () => {
		const response = await connect({ botToken: 'xoxb-wrong-token' });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'slack_failed', code: 'unauthorized' });
		const read = (await (await authFetch(owner.token!, url())).json()) as { integration: unknown };
		expect(read.integration).toBeNull();
	});

	it('posts a test message to the channel', async () => {
		expect((await authFetch(owner.token!, url('/test'), { method: 'POST' })).status).toBe(404);
		await connect();
		const response = await authFetch(owner.token!, url('/test'), { method: 'POST' });
		expect(response.status).toBe(200);
		expect(fakeSlack.posts()).toHaveLength(1);
		expect(fakeSlack.posts()[0]).toMatchObject({ channel: 'C0ERRORS' });
		expect(fakeSlack.posts()[0].text).toContain(project.name);
	});

	it('is owner/admin only', async () => {
		await connect();
		expect((await authFetch(member.token!, url())).status).toBe(403);
		const write = await authFetch(member.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ botToken: SLACK_TOKEN, channelId: 'C0ERRORS' }),
		});
		expect(write.status).toBe(403);
		expect((await authFetch(member.token!, url('/test'), { method: 'POST' })).status).toBe(403);
		expect((await authFetch(member.token!, url(), { method: 'DELETE' })).status).toBe(403);
	});

	it('disconnects and audits every change without the token', async () => {
		await connect();
		await authFetch(owner.token!, url(), {
			method: 'PUT',
			body: JSON.stringify({ notifyResolved: false }),
		});
		expect((await authFetch(owner.token!, url(), { method: 'DELETE' })).status).toBe(200);
		expect((await authFetch(owner.token!, url(), { method: 'DELETE' })).status).toBe(404);

		const audit = await adminFetch(`${BASE}/api/admin/audit?limit=100`);
		const { entries } = (await audit.json()) as {
			entries: { action: string; targetId: string; details: Record<string, unknown> }[];
		};
		const mine = entries.filter(
			(e) => e.targetId === project.id && e.details.integration === 'slack',
		);
		expect(mine.map((e) => e.action)).toEqual(
			expect.arrayContaining(['integration.created', 'integration.updated', 'integration.deleted']),
		);
		expect(JSON.stringify(entries)).not.toContain(SLACK_TOKEN);
	});
});
