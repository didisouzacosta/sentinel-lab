import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { MOBILE_DEFAULT_MAX_EVENTS_PER_HOUR } from '../src/lib/project-defaults';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import { nativeEvent } from './fixtures/symbolicator/events';
import { adminFetch, createTestProject, createTestUser } from './utils';

/**
 * docs/plano-riscos-simbolizacao.md, phase 2: a per-project hourly budget
 * of symbolications, and an event quota for new mobile projects.
 */

const BASE = 'http://localhost';
type Json = Record<string, unknown>;
type Project = Awaited<ReturnType<typeof createTestProject>>;

function bytesOf(b64: string): Uint8Array {
	const binary = atob(b64.replace(/\s+/g, ''));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

describe('Symbolication budget', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;

	const api = (token: string, path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				...(init.headers ?? {}),
			},
		});

	const projectWithDsym = async (name: string): Promise<Project> => {
		const project = await createTestProject(owner.token!, { name, platform: 'cocoa' });
		const upload = await SELF.fetch(
			`${BASE}/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${owner.token}` },
				body: bytesOf(thinB64),
			},
		);
		expect(upload.status).toBe(201);
		return project;
	};

	const setBudget = (project: Project, value: unknown, token = owner.token!) =>
		api(token, `/api/projects/${project.slug}`, {
			method: 'PATCH',
			body: JSON.stringify({ maxSymbolicationsPerHour: value }),
		});

	const settings = async (project: Project) =>
		(await (await api(owner.token!, `/api/projects/${project.slug}/settings`)).json()) as Json;

	const sendEvent = (project: Project, event: Json) =>
		SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
		});

	const parkedCount = async (projectId: string) =>
		(await env.DEBUG_FILES!.list({ prefix: `staging/${projectId}/event-` })).objects.length;

	const storedTags = async (project: Project, eventId: string) => {
		const response = await api(owner.token!, `/api/projects/${project.slug}/events/${eventId}`);
		if (response.status !== 200) return null;
		const data = (await response.json()) as { event: { data?: Json } & Json };
		return JSON.stringify((data.event.data ?? data.event).tags ?? null);
	};

	beforeAll(async () => {
		owner = await createTestUser({
			email: `sym-budget-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Budget Owner',
		});
		member = await createTestUser({
			email: `sym-budget-member-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Budget Member',
		});
	});

	it('defaults to 500 per hour and shows the hour usage in the settings', async () => {
		const project = await projectWithDsym('Budget default');
		expect(await settings(project)).toMatchObject({
			maxSymbolicationsPerHour: 500,
			symbolicationsThisHour: 0,
		});
	});

	it('stores events past the budget right away, tagged skipped', async () => {
		const project = await projectWithDsym('Budget two');
		expect((await setBudget(project, 2)).status).toBe(200);

		const ids = ['b1', 'b2', 'b3'].map((p) => p.repeat(16));
		for (const id of ids) {
			expect((await sendEvent(project, { ...nativeEvent(), event_id: id })).status).toBe(200);
		}
		expect(await parkedCount(project.id)).toBe(2);
		expect(await storedTags(project, ids[0])).toBeNull(); // still waiting
		expect(await storedTags(project, ids[2])).toContain('skipped');
		expect(await settings(project)).toMatchObject({
			maxSymbolicationsPerHour: 2,
			symbolicationsThisHour: 2,
		});
	});

	it('turns symbolication off with 0', async () => {
		const project = await projectWithDsym('Budget off');
		expect((await setBudget(project, 0)).status).toBe(200);
		const id = 'b4'.repeat(16);
		expect((await sendEvent(project, { ...nativeEvent(), event_id: id })).status).toBe(200);
		expect(await parkedCount(project.id)).toBe(0);
		expect(await storedTags(project, id)).toContain('skipped');
	});

	it('does not count events that were never admitted', async () => {
		const project = await createTestProject(owner.token!, {
			name: 'Budget no files',
			platform: 'cocoa',
		});
		const id = 'b5'.repeat(16);
		expect((await sendEvent(project, { ...nativeEvent(), event_id: id })).status).toBe(200);
		expect(await settings(project)).toMatchObject({ symbolicationsThisHour: 0 });
		// No stored file: no tag either, the event is just stored.
		expect(await storedTags(project, id)).not.toContain('skipped');
	});

	it('accepts only integers from 0 to 1000000, from owners and admins', async () => {
		const project = await projectWithDsym('Budget validation');
		for (const bad of [-1, 1.5, '10', 1_000_001]) {
			expect((await setBudget(project, bad)).status).toBe(400);
		}
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
		expect((await setBudget(project, 10, member.token!)).status).toBe(403);
		expect(await settings(project)).toMatchObject({ maxSymbolicationsPerHour: 500 });
	});

	it('gives new mobile projects an hourly event quota, and leaves others unlimited', async () => {
		const quota = async (projectId: string) => {
			const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
			const data = (await (await stub.fetch('http://internal/config')).json()) as {
				config: { maxEventsPerHour: number };
			};
			return data.config.maxEventsPerHour;
		};
		const ios = await createTestProject(owner.token!, { name: 'Quota iOS', platform: 'cocoa' });
		const android = await createTestProject(owner.token!, {
			name: 'Quota Android',
			platform: 'android',
		});
		const web = await createTestProject(owner.token!, {
			name: 'Quota web',
			platform: 'javascript',
		});
		expect(await quota(ios.id)).toBe(MOBILE_DEFAULT_MAX_EVENTS_PER_HOUR);
		expect(await quota(android.id)).toBe(MOBILE_DEFAULT_MAX_EVENTS_PER_HOUR);
		expect(await quota(web.id)).toBe(0);
	});
});
