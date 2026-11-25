import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKaneoTask, priorityForLevel } from '../src/lib/kaneo-task';
import { FAKE_KANEO, fakeKaneo, installFakeKaneo } from './kaneo-fake';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	sendTestEvent,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';

beforeEach(() => installFakeKaneo());
afterEach(() => vi.restoreAllMocks());

describe('Kaneo task body', () => {
	const issue = {
		id: 'issue-1',
		title: 'TypeError: x is undefined',
		culprit: 'app.js in handleClick',
		level: 'error',
		count: 3,
		userCount: 2,
		firstSeen: '2026-11-25T10:00:00.000Z',
		lastSeen: '2026-11-25T11:00:00.000Z',
	};

	it('maps levels to priorities', () => {
		expect(priorityForLevel('fatal')).toBe('urgent');
		expect(priorityForLevel('error')).toBe('high');
		expect(priorityForLevel('warning')).toBe('medium');
		expect(priorityForLevel('info')).toBe('low');
	});

	it('describes the error without personal data', () => {
		const task = buildKaneoTask(
			issue,
			{
				environment: 'production',
				release: 'web@1.2.3',
				user: { email: 'person@example.com', ip_address: '203.0.113.9' },
				exception: {
					values: [
						{
							type: 'TypeError',
							value: 'x is undefined',
							stacktrace: {
								frames: [
									{ filename: 'vendor.js', function: 'outer', lineno: 1 },
									{ filename: 'app.js', function: 'handleClick', lineno: 42, in_app: true },
								],
							},
						},
					],
				},
			},
			{ permalink: 'https://sentinel.test/projects/web/issues/issue-1', projectSlug: 'web' },
		);
		expect(task.title).toBe('[error] TypeError: x is undefined');
		expect(task.priority).toBe('high');
		expect(task.description).toContain('https://sentinel.test/projects/web/issues/issue-1');
		expect(task.description).toContain('production');
		expect(task.description).toContain('web@1.2.3');
		// innermost frame first, app frames marked
		expect(task.description.indexOf('[app] handleClick (app.js:42)')).toBeLessThan(
			task.description.indexOf('outer (vendor.js:1)'),
		);
		expect(task.description).toContain('get_issue');
		expect(task.description).not.toContain('person@example.com');
		expect(task.description).not.toContain('203.0.113.9');
	});
});

describe('Kaneo tasks for issues', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;
	const stub = () => env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(project.id));

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		owner = await createTestUser({
			email: `kt-owner-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Task Owner',
		});
		member = await createTestUser({
			email: `kt-member-${suffix}@example.com`,
			password: 'testpassword123',
			name: 'Task Member',
		});
		project = await createTestProject(owner.token!, { name: `Kaneo Tasks ${suffix}` });
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	async function connect(extra: Record<string, unknown> = {}) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/kaneo`,
			{
				method: 'PUT',
				body: JSON.stringify({
					baseUrl: FAKE_KANEO,
					apiKey: fakeKaneo.validKey,
					kaneoProjectId: 'kp1',
					...extra,
				}),
			},
		);
		expect(response.status).toBe(201);
		fakeKaneo.requests = [];
	}

	async function sendError(message = 'Boom', extra: Record<string, unknown> = {}) {
		await sendTestEvent(project.id, project.publicKey, {
			level: 'error',
			exception: {
				type: 'Error',
				value: message,
				stacktrace: {
					frames: [{ filename: 'app.js', function: 'run', lineno: 7, in_app: true }],
				},
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
			links: { type: string; externalKey: string; externalUrl: string }[];
		};
	}

	async function setStatus(id: string, status: string) {
		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${id}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ status }),
			},
		);
		expect(response.status).toBe(200);
	}

	async function outbox() {
		return runInDurableObject(stub(), async (_instance, state) =>
			state.storage.sql.exec('SELECT * FROM integration_outbox ORDER BY created_at').toArray(),
		);
	}

	async function createTask(token: string, issueId: string) {
		return authFetch(token, `${BASE}/api/projects/${project.slug}/issues/${issueId}/links/kaneo`, {
			method: 'POST',
			body: '{}',
		});
	}

	it('creates one task per issue from the button, linked both ways', async () => {
		await connect();
		await sendError('Manual boom');
		const [issue] = await issues();

		const first = await createTask(owner.token!, issue.id);
		expect(first.status).toBe(201);
		const { link } = (await first.json()) as {
			link: { externalKey: string; externalUrl: string; externalId: string };
		};
		expect(link.externalKey).toBe('SNT-1');
		expect(link.externalUrl).toBe(
			`${FAKE_KANEO}/dashboard/workspace/ws1/project/kp1/task/${link.externalId}`,
		);

		const task = fakeKaneo.tasks.get(link.externalId)!;
		expect(task.title).toBe('[error] Error: Manual boom');
		expect(task.priority).toBe('high');
		expect(task.status).toBe('to-do');
		expect(task.description).toContain(`/projects/${project.slug}/issues/${issue.id}`);
		expect(task.description).not.toContain('secret-user@example.com');
		expect(task.links[0].url).toContain(`/projects/${project.slug}/issues/${issue.id}`);
		expect(task.labels).toEqual(['sentinel']);

		// Idempotent: same task, no second one
		const again = await createTask(owner.token!, issue.id);
		expect(again.status).toBe(200);
		expect(fakeKaneo.tasks.size).toBe(1);

		const detail = await issueDetail(issue.id);
		expect(detail.links).toEqual([
			expect.objectContaining({ type: 'kaneo', externalKey: 'SNT-1' }),
		]);
	});

	it('lets plain members create tasks', async () => {
		await connect();
		await sendError('Member boom');
		const [issue] = await issues();
		const response = await createTask(member.token!, issue.id);
		expect(response.status).toBe(201);
	});

	it('answers 404 without a Kaneo connection and 502 when Kaneo fails', async () => {
		await sendError('No integration');
		const [issue] = await issues();
		expect((await createTask(owner.token!, issue.id)).status).toBe(404);

		await connect();
		fakeKaneo.failWrites = true;
		const failed = await createTask(owner.token!, issue.id);
		expect(failed.status).toBe(502);
		expect(await failed.json()).toMatchObject({ error: 'kaneo_failed', code: 'server_error' });
		expect((await issueDetail(issue.id)).links).toEqual([]);
	});

	it('creates tasks automatically for new issues that match the filters', async () => {
		await connect({ autoCreate: true, minLevel: 'error', environments: ['production'] });

		await sendError('Auto boom', { environment: 'production' });
		await sendTestEvent(project.id, project.publicKey, {
			level: 'warning',
			message: 'Just a warning',
			environment: 'production',
		});
		await sendError('Staging boom', { environment: 'staging' });
		expect((await outbox()).map((row) => row.action)).toEqual(['create']);

		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		expect([...fakeKaneo.tasks.values()].map((t) => t.title)).toEqual(['[error] Error: Auto boom']);

		const auto = (await issues()).find((i) => i.title === 'Error: Auto boom')!;
		expect((await issueDetail(auto.id)).links[0].externalKey).toBe('SNT-1');

		// More events of the same issue never create a second task
		await sendError('Auto boom', { environment: 'production' });
		expect(await outbox()).toEqual([]);
	});

	it('closes the task on resolve and reopens it, without echoing no-op updates', async () => {
		await connect();
		await sendError('Sync boom');
		const [issue] = await issues();
		const { link } = (await (await createTask(owner.token!, issue.id)).json()) as {
			link: { externalId: string };
		};

		await setStatus(issue.id, 'resolved');
		await runDurableObjectAlarm(stub());
		expect(fakeKaneo.tasks.get(link.externalId)!.status).toBe('done');

		// Same status again: no activity row, no delivery
		await setStatus(issue.id, 'resolved');
		expect(await outbox()).toEqual([]);

		await setStatus(issue.id, 'unresolved');
		await runDurableObjectAlarm(stub());
		expect(fakeKaneo.tasks.get(link.externalId)!.status).toBe('to-do');

		// Ignoring does not touch Kaneo
		await setStatus(issue.id, 'ignored');
		expect(await outbox()).toEqual([]);

		const activity = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issue.id}/activity`,
		);
		const rows = (
			(await activity.json()) as { activity: { type: string; data: { to: string } }[] }
		).activity
			.filter((row) => row.type === 'status_change')
			.map((row) => row.data.to);
		expect(rows.sort()).toEqual(['ignored', 'resolved', 'unresolved']);
	});

	it('reopens resolved issues on new events even without a release, and tells Kaneo', async () => {
		await connect();
		await sendError('Regression boom');
		const [issue] = await issues();
		const { link } = (await (await createTask(owner.token!, issue.id)).json()) as {
			link: { externalId: string };
		};
		await setStatus(issue.id, 'resolved');
		await runDurableObjectAlarm(stub());
		expect(fakeKaneo.tasks.get(link.externalId)!.status).toBe('done');

		await sendError('Regression boom'); // no release on purpose
		expect((await issueDetail(issue.id)).issue.status).toBe('unresolved');

		const activity = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/${issue.id}/activity`,
		);
		const regression = (
			(await activity.json()) as {
				activity: { type: string; userId: string; data: { reason?: string } }[];
			}
		).activity.find((row) => row.data.reason === 'regression');
		expect(regression).toMatchObject({ type: 'status_change', userId: 'system' });

		await runDurableObjectAlarm(stub());
		const task = fakeKaneo.tasks.get(link.externalId)!;
		expect(task.status).toBe('to-do');
		expect(task.comments[0]).toContain('came back');
	});

	it('follows bulk status changes', async () => {
		await connect();
		await sendError('Bulk one');
		await sendError('Bulk two');
		const all = await issues();
		for (const issue of all) await createTask(owner.token!, issue.id);

		const response = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/issues/bulk`,
			{
				method: 'PATCH',
				body: JSON.stringify({ issueIds: all.map((i) => i.id), status: 'resolved' }),
			},
		);
		expect(response.status).toBe(200);
		await runDurableObjectAlarm(stub());
		expect([...fakeKaneo.tasks.values()].map((t) => t.status)).toEqual(['done', 'done']);
	});

	it('retries failed deliveries 1/5/30 minutes apart, then records the error', async () => {
		await connect({ autoCreate: true });
		fakeKaneo.failWrites = true;
		await sendError('Outage boom');

		const delays: number[] = [];
		for (let attempt = 1; attempt <= 3; attempt++) {
			await runDurableObjectAlarm(stub());
			const [row] = await outbox();
			expect(row.attempts).toBe(attempt);
			delays.push(new Date(row.next_attempt_at as string).getTime() - Date.now());
			// Pretend the wait is over
			await runInDurableObject(stub(), async (_instance, state) => {
				state.storage.sql.exec(
					'UPDATE integration_outbox SET next_attempt_at = ?',
					new Date(Date.now() - 1000).toISOString(),
				);
				await state.storage.setAlarm(Date.now() + 1000);
			});
		}
		expect(delays[0]).toBeGreaterThan(50_000);
		expect(delays[0]).toBeLessThanOrEqual(60_000);
		expect(delays[1]).toBeGreaterThan(290_000);
		expect(delays[2]).toBeGreaterThan(1_790_000);

		await runDurableObjectAlarm(stub());
		expect(await outbox()).toEqual([]);
		const settings = await authFetch(
			owner.token!,
			`${BASE}/api/projects/${project.slug}/integrations/kaneo`,
		);
		const { integration } = (await settings.json()) as { integration: { lastError: string } };
		expect(integration.lastError).toContain('Could not create the Kaneo task');
		expect(integration.lastError).toContain('Kaneo answered 500');
		expect(fakeKaneo.tasks.size).toBe(0);
	});

	it('drops pending deliveries when Kaneo is disconnected', async () => {
		await connect({ autoCreate: true });
		await sendError('Disconnect boom');
		expect(await outbox()).toHaveLength(1);
		await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/integrations/kaneo`, {
			method: 'DELETE',
		});
		expect(await outbox()).toEqual([]);
	});
});
