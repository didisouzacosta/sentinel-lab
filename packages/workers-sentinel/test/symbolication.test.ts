import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/queue';
import { SYMBOLICATE_LAST_ATTEMPT } from '../src/symbolication-job';
import { Symbolicator, serveDebugFiles } from '../src/symbolicator';
import type { Env, ProcessJob } from '../src/types';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import mappingLines from './fixtures/dif/mapping-lines.txt?raw';
import { DSYM_DEBUG_ID, jvmEvent, MAPPING_UUID, nativeEvent } from './fixtures/symbolicator/events';
import jvmResponseRaw from './fixtures/symbolicator/jvm-response.json?raw';
import nativeResponseRaw from './fixtures/symbolicator/native-response.json?raw';
import { createTestProject, createTestUser } from './utils';

const BASE = 'http://localhost';

function bytesOf(b64: string): Uint8Array {
	const binary = atob(b64.replace(/\s+/g, ''));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

type Json = Record<string, unknown>;

/**
 * Stand-in for the Symbolicator container: answers with responses recorded
 * from the real image (test/fixtures/symbolicator), or fails.
 */
function fakeSymbolicator(mode: 'ok' | 'down', calls: string[] = []) {
	return {
		getByName: (name: string) => ({
			fetch: async (request: Request) => {
				const url = new URL(request.url);
				calls.push(`${name} ${url.pathname}${url.search}`);
				if (mode === 'down') return new Response('container not running', { status: 503 });
				const body = url.pathname === '/symbolicate-jvm' ? jvmResponseRaw : nativeResponseRaw;
				return new Response(body, { headers: { 'Content-Type': 'application/json' } });
			},
		}),
	};
}

function batchOf(job: ProcessJob, attempts: number) {
	const outcome = { acked: false, retried: false };
	const batch = {
		queue: 'sentinel-lab-process',
		messages: [
			{
				id: '1',
				timestamp: new Date(),
				attempts,
				body: job,
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
	return { batch, outcome };
}

describe('Symbolication', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let project: Awaited<ReturnType<typeof createTestProject>>;
	let bare: Awaited<ReturnType<typeof createTestProject>>;

	const api = (path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${owner.token}`, ...(init.headers ?? {}) },
		});

	const sendEvent = (target: { id: string; publicKey: string }, event: Json) => {
		const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() });
		const item = JSON.stringify({ type: 'event' });
		return SELF.fetch(`${BASE}/api/${target.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}`,
			},
			body: `${header}\n${item}\n${JSON.stringify(event)}\n`,
		});
	};

	const parkedKeys = async (projectId: string): Promise<string[]> => {
		const listing = await env.DEBUG_FILES!.list({ prefix: `staging/${projectId}/event-` });
		return listing.objects.map((object) => object.key);
	};

	const storedEvent = async (eventId: string): Promise<Json | null> => {
		const response = await api(`/api/projects/${project.slug}/events/${eventId}`);
		if (response.status !== 200) return null;
		const data = (await response.json()) as { event: { data?: Json } & Json };
		return (data.event.data ?? data.event) as Json;
	};

	const runJob = (key: string, attempts: number, symbolicator: unknown) => {
		const { batch, outcome } = batchOf(
			{ type: 'event.symbolicate', projectId: project.id, key },
			attempts,
		);
		return handleQueue(batch, { ...env, SYMBOLICATOR: symbolicator } as unknown as Env).then(
			() => outcome,
		);
	};

	beforeAll(async () => {
		owner = await createTestUser({
			email: `sym-owner-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Symbolication Owner',
		});
		project = await createTestProject(owner.token!, { name: 'Symbolication', platform: 'cocoa' });
		bare = await createTestProject(owner.token!, { name: 'No debug files', platform: 'cocoa' });
		const dsym = await api(`/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`, {
			method: 'POST',
			body: bytesOf(thinB64),
		});
		expect(dsym.status).toBe(201);
		const proguard = await api(
			`/api/projects/${project.slug}/debug-files?kind=proguard&debugId=${MAPPING_UUID}`,
			{ method: 'POST', body: mappingLines },
		);
		expect(proguard.status).toBe(201);
	});

	it('registers the debug-file handler with the container library', () => {
		// A `static outboundByHost = …` class field would shadow the setter
		// and leave the handler unregistered (container requests get 520).
		expect(Object.getOwnPropertyDescriptor(Symbolicator, 'outboundByHost')).toBeUndefined();
		expect(typeof Symbolicator.outboundByHost?.['sentinel.internal']).toBe('function');
	});

	/** The container id the runtime gives the outbound handler for a project's instance. */
	const instanceOf = (projectId: string) => env.SYMBOLICATOR!.idFromName(projectId).toString();
	const serve = (url: string, fromProject: string) =>
		serveDebugFiles(new Request(url), env as unknown as Env, instanceOf(fromProject));

	it('serves debug files to Symbolicator through the sentry source protocol', async () => {
		const lookup = await serve(
			`http://sentinel.internal/dif/${project.id}/?debug_id=${DSYM_DEBUG_ID}&code_id=${DSYM_DEBUG_ID.replace(/-/g, '')}`,
			project.id,
		);
		const files = (await lookup.json()) as Array<{ id: string; symbolType: string }>;
		expect(files).toHaveLength(1);
		expect(files[0].symbolType).toBe('macho');

		const download = await serve(
			`http://sentinel.internal/dif/${project.id}/?id=${files[0].id}`,
			project.id,
		);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytesOf(thinB64));

		// Another project's source never sees these files.
		const elsewhere = await serve(
			`http://sentinel.internal/dif/${bare.id}/?id=${files[0].id}`,
			bare.id,
		);
		expect(elsewhere.status).toBe(404);
		const unknown = await serve(
			`http://sentinel.internal/dif/${project.id}/?debug_id=${MAPPING_UUID.replace('1', '9')}`,
			project.id,
		);
		expect(await unknown.json()).toEqual([]);
	});

	it("refuses one project's instance access to another project's files", async () => {
		const lookupUrl = `http://sentinel.internal/dif/${project.id}/?debug_id=${DSYM_DEBUG_ID}`;
		const [file] = (await (await serve(lookupUrl, project.id)).json()) as Array<{ id: string }>;
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			// A compromised instance of `bare` forging the path of `project`.
			expect((await serve(lookupUrl, bare.id)).status).toBe(403);
			expect(
				(await serve(`http://sentinel.internal/dif/${project.id}/?id=${file.id}`, bare.id)).status,
			).toBe(403);
			// The old shared instance and arbitrary ids get nothing either.
			expect((await serve(lookupUrl, 'symbolicator')).status).toBe(403);
			const forged = await serveDebugFiles(
				new Request(lookupUrl),
				env as unknown as Env,
				'not-an-id',
			);
			expect(forged.status).toBe(403);
		} finally {
			console.warn = original;
		}
		expect(warnings).toHaveLength(4);
		expect(JSON.parse(warnings[0])).toMatchObject({
			event: 'symbolication.isolation_violation',
			projectId: project.id,
			containerId: instanceOf(bare.id),
		});
	});

	it('stores events without stored debug files right away', async () => {
		const response = await sendEvent(bare, { ...nativeEvent(), event_id: 'c'.repeat(32) });
		expect(response.status).toBe(200);
		expect(await parkedKeys(bare.id)).toEqual([]);
	});

	it('symbolicates a native crash through the queue before storing it', async () => {
		const event = { ...nativeEvent(), event_id: '1'.repeat(32) };
		const response = await sendEvent(project, event);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(event.event_id);

		const keys = await parkedKeys(project.id);
		expect(keys).toHaveLength(1);
		expect(await storedEvent(event.event_id as string)).toBeNull();

		const calls: string[] = [];
		const outcome = await runJob(keys[0], 1, fakeSymbolicator('ok', calls));
		expect(outcome).toEqual({ acked: true, retried: false });
		// The project's own instance, never a shared one.
		expect(calls[0]).toBe(`${project.id} /symbolicate?timeout=30&scope=${project.id}`);

		const stored = await storedEvent(event.event_id as string);
		expect(stored).not.toBeNull();
		const frames = (
			(stored?.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		expect(frames.at(-1)).toMatchObject({ function: 'crash_here', filename: 'crash.c', lineno: 2 });
		expect(JSON.stringify(stored?.tags)).toContain('symbolication');
		expect(await parkedKeys(project.id)).toEqual([]);

		// A redelivery after success is a no-op.
		expect(await runJob(keys[0], 2, fakeSymbolicator('down'))).toEqual({
			acked: true,
			retried: false,
		});
	});

	it('deobfuscates an Android crash and titles the issue with the real type', async () => {
		const event = { ...jvmEvent(), event_id: '2'.repeat(32) };
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);
		expect(await runJob(key, 1, fakeSymbolicator('ok'))).toEqual({ acked: true, retried: false });

		const stored = await storedEvent(event.event_id as string);
		const exception = (stored?.exception as { values: Json[] }).values[0];
		expect(exception.type).toBe('BoomException');
		const issues = (await (await api(`/api/projects/${project.slug}/issues`)).json()) as {
			issues: Array<{ title: string }>;
		};
		expect(issues.issues.some((issue) => issue.title.startsWith('BoomException'))).toBe(true);
	});

	it('retries while Symbolicator is down, then stores the event unsymbolicated', async () => {
		// A crash site not seen before: the same crash as the earlier tests
		// would be answered from the symbolication cache.
		const event = { ...nativeEvent(), event_id: '3'.repeat(32) } as Json;
		const exception = (event.exception as { values: Json[] }).values[0];
		(exception.stacktrace as { frames: Json[] }).frames.push({
			instruction_addr: '0x104b2c468',
			in_app: true,
		});
		expect((await sendEvent(project, event)).status).toBe(200);
		const [key] = await parkedKeys(project.id);

		expect(await runJob(key, 1, fakeSymbolicator('down'))).toEqual({ acked: false, retried: true });
		expect(await storedEvent(event.event_id as string)).toBeNull();

		expect(await runJob(key, SYMBOLICATE_LAST_ATTEMPT, fakeSymbolicator('down'))).toEqual({
			acked: true,
			retried: false,
		});
		const stored = await storedEvent(event.event_id as string);
		expect(stored).not.toBeNull();
		expect(JSON.stringify(stored?.tags)).toContain('failed');
		const frames = (
			(stored?.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		expect(frames.at(-1)?.function).toBeUndefined();
		expect(await parkedKeys(project.id)).toEqual([]);
	});
});
