import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { neededDebugImages } from '../src/lib/debug-files';
import { handleQueue } from '../src/queue';
import { restoreReceivedEvent } from '../src/symbolication-job';
import type { Env, ProcessJob } from '../src/types';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import mappingLines from './fixtures/dif/mapping-lines.txt?raw';
import { DSYM_DEBUG_ID, jvmEvent, MAPPING_UUID, nativeEvent } from './fixtures/symbolicator/events';
import jvmResponseRaw from './fixtures/symbolicator/jvm-response.json?raw';
import nativeResponseRaw from './fixtures/symbolicator/native-response.json?raw';
import { createTestProject, createTestUser } from './utils';

/**
 * Missing debug files per issue, and reprocessing once they are uploaded
 * (docs/plano-debug-files.md, phases 5–6): the tag a crash gets when its
 * dSYM/mapping is not stored, and the routine that symbolicates the issue's
 * latest events again after the upload.
 */

const BASE = 'http://localhost';
type Json = Record<string, unknown>;
type Project = Awaited<ReturnType<typeof createTestProject>>;
interface MissingFile {
	debugId: string;
	kind: string;
	image: string | null;
}

const fakeSymbolicator = {
	getByName: () => ({
		fetch: async (request: Request) => {
			const body =
				new URL(request.url).pathname === '/symbolicate-jvm' ? jvmResponseRaw : nativeResponseRaw;
			return new Response(body, { headers: { 'Content-Type': 'application/json' } });
		},
	}),
};

describe('needed debug images', () => {
	it('needs the app image (in-app frames) but not system libraries', () => {
		expect(neededDebugImages(nativeEvent()).map((image) => image.debugId)).toEqual([DSYM_DEBUG_ID]);
	});

	it('needs every ProGuard mapping', () => {
		expect(neededDebugImages(jvmEvent())).toMatchObject([
			{ debugId: MAPPING_UUID, kind: 'proguard' },
		]);
	});

	it('needs nothing when no frame is in-app', () => {
		const event = nativeEvent();
		for (const frame of (
			(event.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames) {
			frame.in_app = false;
		}
		delete event.threads;
		expect(neededDebugImages(event)).toEqual([]);
	});
});

describe('restoring a symbolicated event', () => {
	it('puts the original frames, type and module back and drops the symbolication tags', () => {
		const event: Json = {
			exception: {
				values: [
					{
						type: 'BoomException',
						module: 'io.sentinel.sample',
						raw_type: 'b',
						raw_module: 'a',
						stacktrace: { frames: [{ function: 'crash' }] },
						raw_stacktrace: { frames: [{ function: 'b' }] },
					},
				],
			},
			tags: { symbolication: 'done', symbolication_cache: 'hit', os: 'android' },
			debug_meta: { images: [{ type: 'proguard', uuid: MAPPING_UUID, debug_status: 'found' }] },
		};
		restoreReceivedEvent(event);
		const exception = (event.exception as { values: Json[] }).values[0];
		expect(exception).toEqual({
			type: 'b',
			module: 'a',
			stacktrace: { frames: [{ function: 'b' }] },
		});
		expect(event.tags).toEqual({ os: 'android' });
		expect((event.debug_meta as { images: Json[] }).images[0]).not.toHaveProperty('debug_status');
	});
});

describe('Reprocessing after an upload', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;

	const api = (path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${owner.token}`, ...(init.headers ?? {}) },
		});

	const sendEvent = async (project: Project, event: Json) => {
		const response = await SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: `${JSON.stringify({ event_id: event.event_id })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
		});
		expect(response.status).toBe(200);
	};

	const issues = async (project: Project) =>
		(
			(await (await api(`/api/projects/${project.slug}/issues`)).json()) as {
				issues: Array<{
					id: string;
					title: string;
					culprit: string | null;
					missingDebugFiles?: MissingFile[];
				}>;
			}
		).issues;

	const storedEvent = async (project: Project, eventId: string): Promise<Json> => {
		const data = (await (await api(`/api/projects/${project.slug}/events/${eventId}`)).json()) as {
			event: { data?: Json } & Json;
		};
		return (data.event.data ?? data.event) as Json;
	};

	const reprocess = (project: Project, issueId: string) =>
		handleQueue(
			{
				queue: 'sentinel-lab-process',
				messages: [
					{
						id: '1',
						timestamp: new Date(),
						attempts: 1,
						body: { type: 'issue.reprocess', projectId: project.id, issueId } satisfies ProcessJob,
						ack: () => {},
						retry: () => {},
					},
				],
				ackAll: () => {},
				retryAll: () => {},
			} as unknown as MessageBatch<ProcessJob>,
			{ ...env, SYMBOLICATOR: fakeSymbolicator } as unknown as Env,
		);

	const bytesOf = (b64: string) =>
		Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));

	beforeAll(async () => {
		owner = await createTestUser({
			email: `reprocess-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Reprocess Owner',
		});
	});

	it('marks an iOS crash without its dSYM, then fixes it once the dSYM is uploaded', async () => {
		const project = await createTestProject(owner.token!, {
			name: 'Reprocess iOS',
			platform: 'cocoa',
		});
		const eventId = 'e1'.repeat(16);
		await sendEvent(project, { ...nativeEvent(), event_id: eventId });

		const [issue] = await issues(project);
		expect(issue.missingDebugFiles).toEqual([
			{ debugId: DSYM_DEBUG_ID, kind: 'macho', image: 'CrashDemo' },
		]);
		expect(JSON.stringify((await storedEvent(project, eventId)).tags)).toContain('missing');

		// The issue's card: the app image is needed, libdyld is not.
		const check = (await (
			await api(`/api/projects/${project.slug}/debug-files/check`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ issueId: issue.id }),
			})
		).json()) as { images: Array<{ debugId: string; needed: boolean; status: string }> };
		expect(check.images.map((image) => [image.debugId, image.needed, image.status])).toEqual([
			[DSYM_DEBUG_ID, true, 'missing'],
			['dddddddd-0000-1111-2222-333333333333', false, 'missing'],
		]);

		const upload = await api(`/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`, {
			method: 'POST',
			body: bytesOf(thinB64),
		});
		expect(upload.status).toBe(201);
		expect(((await upload.json()) as { reprocessing: number }).reprocessing).toBe(1);

		await reprocess(project, issue.id);
		const stored = await storedEvent(project, eventId);
		const frames = (
			(stored.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		expect(frames.at(-1)).toMatchObject({ function: 'crash_here', filename: 'crash.c', lineno: 2 });
		expect(JSON.stringify(stored.tags)).toContain('done');
		expect(JSON.stringify(stored.tags)).toContain('symbolication_reprocessed');

		const [after] = await issues(project);
		expect(after.id).toBe(issue.id); // same issue: grouping does not change
		expect(after.missingDebugFiles).toEqual([]);
		expect(after.culprit).toContain('crash_here');

		// The next crash arrives with the dSYM stored: it is symbolicated at
		// ingest (new fingerprint) and still lands in the same issue.
		const nextId = 'e3'.repeat(16);
		await sendEvent(project, { ...nativeEvent(), event_id: nextId });
		const [parked] = (await env.DEBUG_FILES!.list({ prefix: `staging/${project.id}/event-` }))
			.objects;
		await handleQueue(
			{
				queue: 'sentinel-lab-process',
				messages: [
					{
						id: '2',
						timestamp: new Date(),
						attempts: 1,
						body: {
							type: 'event.symbolicate',
							projectId: project.id,
							key: parked.key,
						} satisfies ProcessJob,
						ack: () => {},
						retry: () => {},
					},
				],
				ackAll: () => {},
				retryAll: () => {},
			} as unknown as MessageBatch<ProcessJob>,
			{ ...env, SYMBOLICATOR: fakeSymbolicator } as unknown as Env,
		);
		const all = await issues(project);
		expect(all).toHaveLength(1);
		expect(all[0].id).toBe(issue.id);
	});

	it('gives an Android issue its real exception name once the mapping is uploaded', async () => {
		const project = await createTestProject(owner.token!, {
			name: 'Reprocess Android',
			platform: 'android',
		});
		const eventId = 'e2'.repeat(16);
		await sendEvent(project, { ...jvmEvent(), event_id: eventId });
		const [issue] = await issues(project);
		expect(issue.title.startsWith('b:')).toBe(true);
		expect(issue.missingDebugFiles).toEqual([
			{ debugId: MAPPING_UUID, kind: 'proguard', image: null },
		]);

		const upload = await api(
			`/api/projects/${project.slug}/debug-files?kind=proguard&debugId=${MAPPING_UUID}`,
			{
				method: 'POST',
				body: mappingLines,
			},
		);
		expect(((await upload.json()) as { reprocessing: number }).reprocessing).toBe(1);

		await reprocess(project, issue.id);
		const [after] = await issues(project);
		expect(after.title.startsWith('BoomException')).toBe(true);
		expect(after.missingDebugFiles).toEqual([]);
		// Reprocessing again starts from the original frames, not from the result.
		await reprocess(project, issue.id);
		const stored = await storedEvent(project, eventId);
		const exception = (stored.exception as { values: Json[] }).values[0];
		expect(exception.raw_type).toBe('b');
		expect(((exception.raw_stacktrace as { frames: Json[] }).frames.at(-1) as Json).function).toBe(
			'b',
		);
	});

	it('queues nothing for uploads no issue was waiting for', async () => {
		const project = await createTestProject(owner.token!, {
			name: 'Reprocess none',
			platform: 'cocoa',
		});
		const upload = await api(`/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`, {
			method: 'POST',
			body: bytesOf(thinB64),
		});
		expect(((await upload.json()) as { reprocessing: number }).reprocessing).toBe(0);
	});
});
