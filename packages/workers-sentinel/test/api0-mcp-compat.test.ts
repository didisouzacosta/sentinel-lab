// /api/0 gaps found by running the official Sentry MCP server
// (@sentry/mcp-server 0.51.0) against Sentinel — docs/compat-mcp-sentry.md:
//  1. issue ids match case-insensitively (the MCP uppercases them);
//  2. the event's `release` is a Release object or null, never a string;
//  3. `notes/` aliases `comments/`, and `activities/` exists;
//  4. `GET /projects/{org}/{project}/` (project detail);
//  5. `GET /auth/` (the token's user, for `whoami`).
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser } from './utils';

const enc = new TextEncoder();
const hexId = () => crypto.randomUUID().replace(/-/g, '');

type Owner = Awaited<ReturnType<typeof createTestUser>>;
type TestProject = Awaited<ReturnType<typeof createTestProject>>;

let owner: Owner;
let apiToken: string;
let project: TestProject;
let issueId: string;
let releasedEventId: string;
let barEventId: string;

async function ingest(target: TestProject, eventId: string, extra: Record<string, unknown>) {
	const envelope = [
		JSON.stringify({ dsn: `https://${target.publicKey}@localhost/${target.id}` }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({
			event_id: eventId,
			timestamp: new Date().toISOString(),
			platform: 'javascript',
			level: 'error',
			...extra,
		}),
	].join('\n');
	const response = await SELF.fetch(`http://localhost/api/${target.id}/envelope/`, {
		method: 'POST',
		headers: { 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}` },
		body: enc.encode(envelope) as unknown as BodyInit,
	});
	expect(response.status, await response.text()).toBe(200);
}

function api0(path: string, init: RequestInit = {}, token = apiToken) {
	return SELF.fetch(`http://localhost/api/0${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	});
}

beforeAll(async () => {
	owner = await createTestUser({
		email: `api0-mcp-${Date.now()}@example.com`,
		password: 'testpassword123',
		name: 'MCP Compat Owner',
	});
	const tokenResponse = await authFetch(owner.token!, 'http://localhost/api/auth/tokens', {
		method: 'POST',
		body: JSON.stringify({ name: 'mcp compat' }),
	});
	expect(tokenResponse.status).toBe(200);
	apiToken = ((await tokenResponse.json()) as { rawToken: string }).rawToken;

	project = await createTestProject(owner.token!, {
		name: `api0-mcp-${crypto.randomUUID().slice(0, 8)}`,
	});
	// Same message → same issue: one event with a release, one without.
	releasedEventId = hexId();
	barEventId = hexId();
	await ingest(project, releasedEventId, { message: 'mcp compat probe', release: 'web@1.2.3' });
	await ingest(project, barEventId, { message: 'mcp compat probe' });

	const native = await authFetch(
		owner.token!,
		`http://localhost/api/projects/${project.slug}/issues`,
	);
	const issues = ((await native.json()) as { issues: Array<{ id: string }> }).issues;
	expect(issues).toHaveLength(1);
	issueId = issues[0].id;
	expect(issueId).toBe(issueId.toLowerCase());
}, 120_000);

describe('/api/0 issue ids are case-insensitive', () => {
	it('resolves an uppercased id on every issue route', async () => {
		const upper = issueId.toUpperCase();

		const detail = await api0(`/organizations/sentinel/issues/${upper}/`);
		expect(detail.status).toBe(200);
		expect(((await detail.json()) as { id: string }).id).toBe(issueId);

		const alias = await api0(`/issues/${upper}/`);
		expect(alias.status).toBe(200);

		const events = await api0(`/organizations/sentinel/issues/${upper}/events/`);
		expect(events.status).toBe(200);
		const eventList = (await events.json()) as Array<{ groupID: string }>;
		expect(eventList).toHaveLength(2);
		expect(eventList[0].groupID).toBe(issueId);

		const projectEvents = await api0(`/projects/sentinel/${project.slug}/issues/${upper}/events/`);
		expect(projectEvents.status).toBe(200);

		const latest = await api0(`/organizations/sentinel/issues/${upper}/events/latest/`);
		expect(latest.status).toBe(200);

		const concrete = await api0(`/organizations/sentinel/issues/${upper}/events/${barEventId}/`);
		expect(concrete.status).toBe(200);

		const updated = await api0(`/organizations/sentinel/issues/${upper}/`, {
			method: 'PUT',
			body: JSON.stringify({ status: 'unresolved' }),
		});
		expect(updated.status).toBe(200);
		expect(((await updated.json()) as { id: string }).id).toBe(issueId);
	});
});

describe('/api/0 event release is a Release object', () => {
	it('serializes a release string as {version, …} and a missing one as null', async () => {
		const withRelease = await api0(`/projects/sentinel/${project.slug}/events/${releasedEventId}/`);
		expect(withRelease.status).toBe(200);
		const released = (await withRelease.json()) as { release: Record<string, unknown> | null };
		expect(released.release).not.toBeNull();
		expect(released.release?.version).toBe('web@1.2.3');
		expect(released.release?.shortVersion).toBe('web@1.2.3');
		expect(released.release?.lastCommit).toBeNull();

		const without = await api0(`/projects/sentinel/${project.slug}/events/${barEventId}/`);
		expect(((await without.json()) as { release: unknown }).release).toBeNull();

		// Same serializer on the issue event list and the eventids lookup.
		const list = await api0(`/organizations/sentinel/issues/${issueId}/events/`);
		const releases = ((await list.json()) as Array<{ release: unknown }>).map((e) => e.release);
		for (const release of releases) {
			expect(release === null || typeof release === 'object').toBe(true);
		}
		const lookup = await api0(`/organizations/sentinel/eventids/${releasedEventId}/`);
		const envelope = (await lookup.json()) as { event: { release: { version: string } } };
		expect(envelope.event.release.version).toBe('web@1.2.3');
	});
});

describe('/api/0 notes and activities', () => {
	it('notes/ round-trips like comments/, with the text under data.text', async () => {
		const upper = issueId.toUpperCase();
		const created = await api0(`/organizations/sentinel/issues/${upper}/notes/`, {
			method: 'POST',
			body: JSON.stringify({ text: 'mcp triage note' }),
		});
		expect(created.status).toBe(201);
		const note = (await created.json()) as Record<string, unknown>;
		expect(note.type).toBe('note');
		expect(note.data).toEqual({ text: 'mcp triage note' });
		expect(note.text).toBe('mcp triage note');
		expect(note.issueId).toBe(issueId);
		expect((note.user as { name: string }).name).toBe('MCP Compat Owner');

		const notes = await api0(`/organizations/sentinel/issues/${issueId}/notes/`);
		expect(notes.status).toBe(200);
		const noteList = (await notes.json()) as Array<Record<string, unknown>>;
		expect(noteList.map((n) => n.id)).toEqual([note.id]);
		expect(noteList[0].data).toEqual({ text: 'mcp triage note' });

		// Same store as comments/.
		const comments = await api0(`/organizations/sentinel/issues/${issueId}/comments/`);
		expect(((await comments.json()) as Array<{ id: string }>).map((n) => n.id)).toEqual([note.id]);

		const deleted = await api0(`/organizations/sentinel/issues/${upper}/notes/${note.id}/`, {
			method: 'DELETE',
		});
		expect(deleted.status).toBe(204);
		const after = await api0(`/organizations/sentinel/issues/${issueId}/notes/`);
		expect(await after.json()).toEqual([]);
	});

	it('activities/ lists notes and status changes newest first, ending with first_seen', async () => {
		const resolve = await api0(`/organizations/sentinel/issues/${issueId}/`, {
			method: 'PUT',
			body: JSON.stringify({ status: 'resolved' }),
		});
		expect(resolve.status).toBe(200);
		const created = await api0(`/organizations/sentinel/issues/${issueId}/notes/`, {
			method: 'POST',
			body: JSON.stringify({ text: 'resolved by the agent' }),
		});
		const note = (await created.json()) as { id: string };

		const response = await api0(
			`/organizations/sentinel/issues/${issueId.toUpperCase()}/activities/`,
		);
		expect(response.status).toBe(200);
		const { activity } = (await response.json()) as {
			activity: Array<{
				id: string;
				type: string;
				data: Record<string, unknown>;
				dateCreated: string;
				user: { id: string; name: string } | null;
			}>;
		};
		const types = activity.map((entry) => entry.type);
		expect(types[0]).toBe('note');
		expect(types).toContain('set_resolved');
		expect(types[types.length - 1]).toBe('first_seen');

		const noteEntry = activity[0];
		expect(noteEntry.id).toBe(note.id);
		expect(noteEntry.data).toEqual({ text: 'resolved by the agent' });
		expect(noteEntry.user?.id).toBe(owner.id);

		const resolvedEntry = activity.find((entry) => entry.type === 'set_resolved');
		expect(resolvedEntry?.user?.name).toBe('MCP Compat Owner');
		for (const entry of activity) {
			expect(Number.isNaN(Date.parse(entry.dateCreated))).toBe(false);
		}

		const unknown = await api0(`/organizations/sentinel/issues/${crypto.randomUUID()}/activities/`);
		expect(unknown.status).toBe(404);
	});
});

describe('/api/0 project detail', () => {
	it('returns the list serializer by slug or id, 404 otherwise', async () => {
		const bySlug = await api0(`/projects/sentinel/${project.slug}/`);
		expect(bySlug.status).toBe(200);
		const detail = (await bySlug.json()) as Record<string, unknown>;

		const list = await api0('/organizations/sentinel/projects/');
		const entry = ((await list.json()) as Array<Record<string, unknown>>).find(
			(p) => p.id === project.id,
		);
		expect(detail).toEqual(entry);
		expect(detail.slug).toBe(project.slug);

		const byId = await api0(`/projects/sentinel/${project.id}`);
		expect(byId.status).toBe(200);
		expect(((await byId.json()) as { id: string }).id).toBe(project.id);

		const missing = await api0('/projects/sentinel/no-such-project/');
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ detail: 'not found' });

		// Non-members get the same 404.
		const stranger = await createTestUser({
			email: `api0-mcp-stranger-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Stranger',
		});
		const hidden = await api0(`/projects/sentinel/${project.slug}/`, {}, stranger.token!);
		expect(hidden.status).toBe(404);
	});
});

describe('/api/0/auth/', () => {
	it("returns the token's user", async () => {
		for (const path of ['/auth/', '/auth']) {
			const response = await api0(path);
			expect(response.status).toBe(200);
			const user = (await response.json()) as Record<string, unknown>;
			expect(user.id).toBe(owner.id);
			expect(user.email).toBe(owner.email);
			expect(user.name).toBe('MCP Compat Owner');
		}
		// Session tokens work too.
		const session = await api0('/auth/', {}, owner.token!);
		expect(((await session.json()) as { id: string }).id).toBe(owner.id);
	});

	it('rejects anonymous callers with a Sentry-shaped 401', async () => {
		const response = await SELF.fetch('http://localhost/api/0/auth/');
		expect(response.status).toBe(401);
		expect(typeof ((await response.json()) as { detail: unknown }).detail).toBe('string');
	});
});
