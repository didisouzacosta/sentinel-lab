import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/queue';
import { SYMBOLICATE_LAST_ATTEMPT, SYMBOLICATE_MAX_WAIT_MS } from '../src/symbolication-job';
import type { Env, ProcessJob } from '../src/types';
import wranglerConfig from '../wrangler.jsonc?raw';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import { nativeEvent } from './fixtures/symbolicator/events';
import nativeResponseRaw from './fixtures/symbolicator/native-response.json?raw';
import { createTestProject, createTestUser } from './utils';

/**
 * Failure modes of the symbolication queue: nothing may lose an event,
 * burn retries on input that can never succeed, bypass the project quota,
 * or write into a project that was deleted meanwhile.
 */

const BASE = 'http://localhost';
type Json = Record<string, unknown>;
type Project = Awaited<ReturnType<typeof createTestProject>>;

function bytesOf(b64: string): Uint8Array {
	const binary = atob(b64.replace(/\s+/g, ''));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function fakeSymbolicator(answer: () => Response, calls: string[] = []) {
	return {
		getByName: () => ({
			fetch: async (request: Request) => {
				calls.push(new URL(request.url).pathname);
				return answer();
			},
		}),
	};
}
const ok = () =>
	new Response(nativeResponseRaw, { headers: { 'Content-Type': 'application/json' } });
const unprocessable = () =>
	new Response('Failed to deserialize the JSON body into the target type: …', { status: 422 });

/** PROJECT_STATE that refuses the symbolicated event (as SQLite does with an oversized row). */
function refusingSymbolicatedIngest(): Env['PROJECT_STATE'] {
	const real = env.PROJECT_STATE;
	return {
		idFromName: (name: string) => real.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = real.get(id);
			return {
				fetch: async (request: Request) => {
					if (new URL(request.url).pathname === '/ingest-with-attachments') {
						const body = await request.clone().text();
						if (body.includes('raw_stacktrace')) {
							return Response.json({ error: 'internal_error' }, { status: 500 });
						}
					}
					return stub.fetch(request);
				},
			};
		},
	} as unknown as Env['PROJECT_STATE'];
}

describe('Symbolication failure modes', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;

	const api = (path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${owner.token}`, ...(init.headers ?? {}) },
		});

	const newProjectWithDsym = async (name: string): Promise<Project> => {
		const project = await createTestProject(owner.token!, { name, platform: 'cocoa' });
		const upload = await api(`/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`, {
			method: 'POST',
			body: bytesOf(thinB64),
		});
		expect(upload.status).toBe(201);
		return project;
	};

	const sendEvent = (project: Project, event: Json) =>
		SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
		});

	const parkedKeys = async (projectId: string) =>
		(await env.DEBUG_FILES!.list({ prefix: `staging/${projectId}/event-` })).objects.map(
			(o) => o.key,
		);

	const storedEvent = async (projectId: string, eventId: string): Promise<Json | null> => {
		const stub = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
		const response = await stub.fetch(
			new Request('http://internal/event', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ eventId }),
			}),
		);
		if (response.status !== 200) return null;
		const data = (await response.json()) as { event?: { data?: Json } & Json };
		return data.event ? ((data.event.data ?? data.event) as Json) : null;
	};

	const runJob = async (
		project: Project,
		key: string,
		attempts: number,
		overrides: Partial<Env>,
	) => {
		const outcome = { acked: false, retried: false };
		const batch = {
			queue: 'sentinel-lab-process',
			messages: [
				{
					id: '1',
					timestamp: new Date(),
					attempts,
					body: { type: 'event.symbolicate', projectId: project.id, key } satisfies ProcessJob,
					ack: () => {
						outcome.acked = true;
					},
					retry: () => {
						outcome.retried = true;
					},
				},
			],
			ackAll: () => {},
			retryAll: () => {},
		} as unknown as MessageBatch<ProcessJob>;
		await handleQueue(batch, { ...env, ...overrides } as unknown as Env);
		return outcome;
	};

	const tagsOf = (event: Json | null) => JSON.stringify(event?.tags ?? null);

	beforeAll(async () => {
		owner = await createTestUser({
			email: `sym-hard-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Symbolication Hardening',
		});
	});

	it('does not retry a request Symbolicator rejects as malformed', async () => {
		const project = await newProjectWithDsym('Sym 422');
		const event = { ...nativeEvent(), event_id: 'd1'.repeat(16) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);

		const calls: string[] = [];
		const outcome = await runJob(project, key, 1, {
			SYMBOLICATOR: fakeSymbolicator(unprocessable, calls) as never,
		});
		expect(outcome).toEqual({ acked: true, retried: false });
		expect(calls).toEqual(['/symbolicate']);
		const stored = await storedEvent(project.id, event.event_id);
		expect(stored).not.toBeNull();
		expect(tagsOf(stored)).toContain('failed');
		expect(await parkedKeys(project.id)).toEqual([]);
	});

	it('retries when no instance can start (capacity), then stores the event as received', async () => {
		const project = await newProjectWithDsym('Sym capacity');
		const event = { ...nativeEvent(), event_id: 'd7'.repeat(16) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);
		const full = () => {
			throw new Error('Maximum number of running container instances exceeded');
		};

		expect(
			await runJob(project, key, 1, { SYMBOLICATOR: fakeSymbolicator(full) as never }),
		).toEqual({ acked: false, retried: true });
		expect(await storedEvent(project.id, event.event_id)).toBeNull();

		expect(
			await runJob(project, key, SYMBOLICATE_LAST_ATTEMPT, {
				SYMBOLICATOR: fakeSymbolicator(full) as never,
			}),
		).toEqual({ acked: true, retried: false });
		expect(tagsOf(await storedEvent(project.id, event.event_id))).toContain('failed');
	});

	it('stores an event that waited too long without calling the container', async () => {
		const project = await newProjectWithDsym('Sym backlog');
		const event = { ...nativeEvent(), event_id: 'd8'.repeat(16) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);
		// Rewrite the parked copy as if it had waited 11 minutes.
		const parked = JSON.parse(await (await env.DEBUG_FILES!.get(key))!.text());
		parked.parkedAt = new Date(Date.now() - SYMBOLICATE_MAX_WAIT_MS - 60_000).toISOString();
		await env.DEBUG_FILES!.put(key, JSON.stringify(parked));

		const calls: string[] = [];
		const outcome = await runJob(project, key, 1, {
			SYMBOLICATOR: fakeSymbolicator(ok, calls) as never,
		});
		expect(outcome).toEqual({ acked: true, retried: false });
		expect(calls).toEqual([]);
		const tags = tagsOf(await storedEvent(project.id, event.event_id));
		expect(tags).toContain('skipped');
		expect(tags).toContain('backlog');
		expect(await parkedKeys(project.id)).toEqual([]);
	});

	it('caps concurrent symbolication jobs in the queue consumer', () => {
		// wrangler.jsonc is read as text: the consumer must keep a concurrency cap.
		expect(wranglerConfig).toMatch(/"max_concurrency":\s*4\b/);
	});

	it('stores the event as received when ProjectState refuses the symbolicated one', async () => {
		const project = await newProjectWithDsym('Sym ingest refusal');
		const event = { ...nativeEvent(), event_id: 'd2'.repeat(16) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);

		const outcome = await runJob(project, key, 1, {
			SYMBOLICATOR: fakeSymbolicator(ok) as never,
			PROJECT_STATE: refusingSymbolicatedIngest(),
		});
		expect(outcome).toEqual({ acked: true, retried: false });
		const stored = await storedEvent(project.id, event.event_id);
		expect(stored).not.toBeNull();
		expect(stored?.exception).toBeDefined();
		expect(JSON.stringify(stored)).not.toContain('raw_stacktrace');
		expect(tagsOf(stored)).toContain('failed');
	});

	it('finds the app image among hundreds of loaded system images', async () => {
		const project = await newProjectWithDsym('Sym many images');
		const event = { ...nativeEvent(), event_id: 'd6'.repeat(16) } as Json;
		const images = (event.debug_meta as { images: Json[] }).images;
		const appImage = images.shift() as Json;
		// iOS reports every loaded image; the app's own can come late.
		for (let i = 0; i < 400; i++) {
			const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
			images.push({
				type: 'macho',
				debug_id: id,
				image_addr: `0x${(0x180000000 + i * 0x10000).toString(16)}`,
			});
		}
		images.push(appImage);
		expect((await sendEvent(project, event)).status).toBe(200);
		expect(await parkedKeys(project.id)).toHaveLength(1);
	});

	it('answers 429 instead of queueing when the project quota is used up', async () => {
		const project = await newProjectWithDsym('Sym quota');
		const settings = await api(`/api/projects/${project.slug}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ maxEventsPerHour: 1 }),
		});
		expect(settings.status).toBe(200);
		// Spend the hour's quota with a plain event.
		expect((await sendEvent(project, { event_id: 'd3'.repeat(16), message: 'first' })).status).toBe(
			200,
		);

		const response = await sendEvent(project, { ...nativeEvent(), event_id: 'd4'.repeat(16) });
		expect(response.status).toBe(429);
		expect(await parkedKeys(project.id)).toEqual([]);
	});

	it('drops a queued event whose project was deleted meanwhile', async () => {
		const project = await newProjectWithDsym('Sym deleted');
		const event = { ...nativeEvent(), event_id: 'd5'.repeat(16) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);
		const parked = await (await env.DEBUG_FILES!.get(key))!.text();

		const deleted = await api(`/api/projects/${project.slug}`, { method: 'DELETE' });
		expect(deleted.status).toBeLessThan(300);
		// The consumer may have read the object before the purge swept it.
		await env.DEBUG_FILES!.put(key, parked);

		const calls: string[] = [];
		const outcome = await runJob(project, key, 1, {
			SYMBOLICATOR: fakeSymbolicator(ok, calls) as never,
		});
		expect(outcome).toEqual({ acked: true, retried: false });
		expect(calls).toEqual([]); // no container work for a deleted project
		expect(await storedEvent(project.id, event.event_id)).toBeNull();
		expect(await parkedKeys(project.id)).toEqual([]);
	});
});
