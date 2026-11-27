import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSlackIssueMessage } from '../src/lib/slack-message';
import { fakeSlack, installFakeSlack, SLACK_TOKEN } from './slack-fake';
import {
	authFetch,
	createTestProject,
	createTestUser,
	sendTestEvent,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';

beforeEach(() => installFakeSlack());
afterEach(() => vi.restoreAllMocks());

const issue = {
	id: 'issue-1',
	title: 'Boom',
	culprit: null,
	level: 'error',
	status: 'unresolved',
	count: 1,
	userCount: 0,
	firstSeen: '2026-11-25T10:00:00.000Z',
	lastSeen: '2026-11-25T11:00:00.000Z',
};
const context = { permalink: 'https://sentinel.test/x', projectName: 'Web' };

describe('Slack message limits and escaping', () => {
	it('keeps every section under Slack 3000-character limit', () => {
		const generic = '&<>'.repeat(400);
		const message = buildSlackIssueMessage(
			{ ...issue, title: generic, culprit: generic },
			{
				exception: {
					values: [
						{
							type: 'ClassCastException',
							value: generic,
							stacktrace: {
								frames: Array.from({ length: 8 }, () => ({
									filename: generic,
									function: generic,
									in_app: true,
								})),
							},
						},
					],
				},
			},
			context,
		);
		for (const block of message.blocks as {
			text?: { text: string };
			fields?: { text: string }[];
		}[]) {
			if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
			for (const field of block.fields ?? []) expect(field.text.length).toBeLessThanOrEqual(2000);
		}
		const code = (message.blocks as { text?: { text: string } }[])
			.map((b) => b.text?.text ?? '')
			.find((t) => t.startsWith('```'))!;
		expect(code.endsWith('```')).toBe(true);
		expect(code).not.toMatch(/&[a-z]*```$/);
	});

	it('never lets an error title mention the channel in the notification text', () => {
		const message = buildSlackIssueMessage(
			{ ...issue, title: '<!channel> <https://evil.example|click>' },
			null,
			context,
		);
		expect(message.text).not.toContain('<!channel>');
		expect(message.text).not.toContain('<https://evil.example');
	});
});

describe('Slack edge cases in delivery', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const stub = () => env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));
	const settings = () => `${BASE}/api/projects/${project.slug}/integrations/slack`;

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `se-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Slack Edge',
		});
		project = await createTestProject(owner.token!, { name: `Slack Edge ${suffix}` });
		const response = await authFetch(owner.token!, settings(), {
			method: 'PUT',
			body: JSON.stringify({ botToken: SLACK_TOKEN, channelId: 'C0ERRORS' }),
		});
		expect(response.status).toBe(201);
	});

	// Same fake channel for every test: drop this project's pending
	// deliveries so a retry cannot fire during a later test.
	afterEach(async () => {
		if (!project) return;
		await authFetch(owner.token!, settings(), { method: 'DELETE' }).catch(() => {});
	});

	async function postedIssue() {
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: { type: 'Error', value: `Edge ${Math.random()}` },
		});
		await runDurableObjectAlarm(stub());
		const list = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues?status=`,
		);
		const [first] = ((await list.json()) as { issues: { id: string }[] }).issues;
		return first.id;
	}

	async function setStatus(id: string, status: string) {
		await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/issues/${id}`, {
			method: 'PATCH',
			body: JSON.stringify({ status }),
		});
	}

	async function outbox() {
		return runInDurableObject(stub(), async (_i, state) =>
			state.storage.sql.exec('SELECT * FROM integration_outbox').toArray(),
		);
	}

	async function links() {
		return runInDurableObject(stub(), async (_i, state) =>
			state.storage.sql.exec('SELECT * FROM issue_links').toArray(),
		);
	}

	it('forgets a message someone deleted in Slack instead of failing forever', async () => {
		const id = await postedIssue();
		fakeSlack.messages = [];
		await setStatus(id, 'resolved');
		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		expect(await links()).toEqual([]);
		const read = (await (await authFetch(owner.token!, settings())).json()) as {
			integration: { lastError: string | null };
		};
		expect(read.integration.lastError).toBeNull();
	});

	it('posts a fresh message when a regression finds the old one deleted', async () => {
		const id = await postedIssue();
		await setStatus(id, 'resolved');
		await runDurableObjectAlarm(stub());
		fakeSlack.messages = [];
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: { type: 'Error', value: 'never mind' },
		});
		// the regression of the first issue
		const list = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues?status=`,
		);
		const issues = ((await list.json()) as { issues: { id: string; title: string }[] }).issues;
		const original = issues.find((i) => i.id === id)!;
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: { type: 'Error', value: original.title.replace(/^Error: /, '') },
		});
		await runDurableObjectAlarm(stub());
		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		const posts = fakeSlack.posts().filter((m) => m.text.includes(original.title));
		expect(posts).toHaveLength(1);
		expect(posts[0].text).toMatch(/^Came back in /);
	});

	it('drops links to the old workspace when the token changes workspace', async () => {
		await postedIssue();
		expect(await links()).toHaveLength(1);
		const otherToken = 'xoxb-9999-other-workspace';
		fakeSlack.validToken = otherToken;
		fakeSlack.team = { id: 'T0OTHER', name: 'Other' };
		const response = await authFetch(owner.token!, settings(), {
			method: 'PUT',
			body: JSON.stringify({ botToken: otherToken, channelId: 'C0ERRORS' }),
		});
		expect(response.status).toBe(200);
		expect(await links()).toEqual([]);
	});
});
