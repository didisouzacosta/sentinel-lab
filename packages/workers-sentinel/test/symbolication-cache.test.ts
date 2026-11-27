import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildJvmRequest, buildNativeRequest } from '../src/lib/symbolicate';
import { cacheKey, rebaseAnswer } from '../src/lib/symbolication-cache';
import { handleQueue } from '../src/queue';
import type { Env, ProcessJob } from '../src/types';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import mappingLines from './fixtures/dif/mapping-lines.txt?raw';
import { IMAGE_ADDR, jvmEvent, MAPPING_UUID, nativeEvent } from './fixtures/symbolicator/events';
import jvmResponseRaw from './fixtures/symbolicator/jvm-response.json?raw';
import nativeResponseRaw from './fixtures/symbolicator/native-response.json?raw';
import { createTestProject, createTestUser } from './utils';

/** docs/plano-riscos-simbolizacao.md, phase 4: the Symbolicator answer cache. */

type Json = Record<string, unknown>;
const SHIFT = 0x2_0000_0000; // another ASLR slide

/** The fixture crash with the app image (and its frames) loaded elsewhere. */
function slidNativeEvent(shift = SHIFT): Json {
	const event = nativeEvent();
	const slide = (hex: string) => `0x${(BigInt(hex) + BigInt(shift)).toString(16)}`;
	const image = (event.debug_meta as { images: Json[] }).images[0];
	image.image_addr = slide(image.image_addr as string);
	const holders = [
		(event.exception as { values: Json[] }).values[0],
		...(event.threads as { values: Json[] }).values,
	];
	for (const holder of holders) {
		const st = holder.stacktrace as { frames: Json[]; registers?: Json };
		for (const frame of st.frames) {
			const addr = frame.instruction_addr;
			if (
				typeof addr === 'string' &&
				BigInt(addr) >= BigInt(IMAGE_ADDR) &&
				BigInt(addr) < BigInt(IMAGE_ADDR) + 16384n
			) {
				frame.instruction_addr = slide(addr);
			}
		}
		if (st.registers) st.registers = { pc: slide(st.registers.pc as string) };
	}
	return event;
}

describe('symbolication cache keys', () => {
	const keyOf = (event: Json) => cacheKey('/symbolicate', buildNativeRequest(event, 'p')!.body);

	it('gives the same crash the same key wherever ASLR loaded the image', () => {
		expect(keyOf(slidNativeEvent()).key).toBe(keyOf(nativeEvent()).key);
		expect(keyOf(slidNativeEvent(0x1000)).key).toBe(keyOf(nativeEvent()).key);
	});

	it('tells different crash sites apart, and keeps addresses outside any image absolute', () => {
		const other = nativeEvent();
		const frames = (
			(other.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		frames[4].instruction_addr = `0x${(IMAGE_ADDR + 0x468).toString(16)}`;
		expect(keyOf(other).key).not.toBe(keyOf(nativeEvent()).key);

		const outside = nativeEvent();
		const outFrames = (
			(outside.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		outFrames[0].instruction_addr = '0x19a000200'; // libdyld frame, another address
		expect(keyOf(outside).key).not.toBe(keyOf(nativeEvent()).key);
	});

	it('ignores the source (project) in JVM keys and lists the mapping ids', () => {
		const a = cacheKey('/symbolicate-jvm', buildJvmRequest(jvmEvent(), 'project-a')!.body);
		const b = cacheKey('/symbolicate-jvm', buildJvmRequest(jvmEvent(), 'project-b')!.body);
		expect(a.key).toBe(b.key);
		expect(a.debugIds).toEqual([MAPPING_UUID]);
	});

	it('moves symbol addresses onto the current image address on a hit', () => {
		const then = cacheKey('/symbolicate', buildNativeRequest(nativeEvent(), 'p')!.body);
		const now = cacheKey('/symbolicate', buildNativeRequest(slidNativeEvent(), 'p')!.body);
		const answer = JSON.parse(nativeResponseRaw);
		const rebased = rebaseAnswer({ result: answer, bases: then.bases }, now);
		const before = answer.stacktraces[0].frames;
		const after = (rebased.stacktraces as Array<{ frames: Json[] }>)[0].frames;
		// crash_here, in the app image: moved by the slide.
		expect(BigInt(after[0].sym_addr as string) - BigInt(before[0].sym_addr)).toBe(BigInt(SHIFT));
		// libdyld frame, outside any image sent: untouched.
		expect(after[3].instruction_addr).toBe(before[3].instruction_addr);
		// The cached copy is not modified.
		expect(answer.stacktraces[0].frames[0].sym_addr).toBe(before[0].sym_addr);
	});
});

describe('symbolication cache in the queue', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let project: Awaited<ReturnType<typeof createTestProject>>;
	const BASE = 'http://localhost';

	const bytesOf = (b64: string) =>
		Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
	const api = (path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${owner.token}`, ...(init.headers ?? {}) },
		});

	const fake = (calls: string[]) => ({
		getByName: () => ({
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname;
				calls.push(path);
				const body = path === '/symbolicate-jvm' ? jvmResponseRaw : nativeResponseRaw;
				return new Response(body, { headers: { 'Content-Type': 'application/json' } });
			},
		}),
	});

	/** Send an event, run its queue job with a fake container, return the stored event. */
	const symbolicate = async (event: Json, calls: string[]): Promise<Json> => {
		const header = JSON.stringify({ event_id: event.event_id });
		const response = await SELF.fetch(`${BASE}/api/${project.id}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
			},
			body: `${header}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`,
		});
		expect(response.status).toBe(200);
		const [object] = (await env.DEBUG_FILES!.list({ prefix: `staging/${project.id}/event-` }))
			.objects;
		const batch = {
			queue: 'sentinel-lab-process',
			messages: [
				{
					id: '1',
					timestamp: new Date(),
					attempts: 1,
					body: {
						type: 'event.symbolicate',
						projectId: project.id,
						key: object.key,
					} satisfies ProcessJob,
					ack: () => {},
					retry: () => {},
				},
			],
			ackAll: () => {},
			retryAll: () => {},
		} as unknown as MessageBatch<ProcessJob>;
		await handleQueue(batch, { ...env, SYMBOLICATOR: fake(calls) } as unknown as Env);
		const stored = await api(`/api/projects/${project.slug}/events/${event.event_id}`);
		expect(stored.status).toBe(200);
		const data = (await stored.json()) as { event: { data?: Json } & Json };
		return (data.event.data ?? data.event) as Json;
	};

	beforeAll(async () => {
		owner = await createTestUser({
			email: `sym-cache-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Cache Owner',
		});
		project = await createTestProject(owner.token!, {
			name: 'Symbolication cache',
			platform: 'cocoa',
		});
		expect(
			(
				await api(`/api/projects/${project.slug}/debug-files?kind=dsym&name=CrashDemo`, {
					method: 'POST',
					body: bytesOf(thinB64),
				})
			).status,
		).toBe(201);
		expect(
			(
				await api(
					`/api/projects/${project.slug}/debug-files?kind=proguard&debugId=${MAPPING_UUID}`,
					{ method: 'POST', body: mappingLines },
				)
			).status,
		).toBe(201);
	});

	it('answers the same crash from another device without calling the container', async () => {
		const calls: string[] = [];
		const first = await symbolicate({ ...nativeEvent(), event_id: 'c1'.repeat(16) }, calls);
		expect(calls).toEqual(['/symbolicate']);
		expect(JSON.stringify(first.tags)).not.toContain('symbolication_cache');

		const second = await symbolicate({ ...slidNativeEvent(), event_id: 'c2'.repeat(16) }, calls);
		expect(calls).toEqual(['/symbolicate']); // no second call
		expect(JSON.stringify(second.tags)).toContain('symbolication_cache');
		const frames = (
			(second.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames;
		const top = frames.at(-1) as Json;
		expect(top).toMatchObject({ function: 'crash_here', lineno: 2 });
		// Symbol address on the second device's image, not the first one's.
		const firstTop = (
			(first.exception as { values: Json[] }).values[0].stacktrace as { frames: Json[] }
		).frames.at(-1) as Json;
		expect(BigInt(top.symbol_addr as string) - BigInt(firstTop.symbol_addr as string)).toBe(
			BigInt(SHIFT),
		);
	});

	it('calls the container again once a debug file the crash refers to is uploaded', async () => {
		const LATER = '22222222-3333-4444-5555-666666666666';
		const event = () => {
			const e = jvmEvent();
			(e.debug_meta as { images: Json[] }).images.push({ type: 'proguard', uuid: LATER });
			return e;
		};
		const calls: string[] = [];
		await symbolicate({ ...event(), event_id: 'c3'.repeat(16) }, calls);
		await symbolicate({ ...event(), event_id: 'c4'.repeat(16) }, calls);
		expect(calls).toEqual(['/symbolicate-jvm']); // second one from the cache

		expect(
			(
				await api(`/api/projects/${project.slug}/debug-files?kind=proguard&debugId=${LATER}`, {
					method: 'POST',
					body: mappingLines,
				})
			).status,
		).toBe(201);
		await symbolicate({ ...event(), event_id: 'c5'.repeat(16) }, calls);
		expect(calls).toEqual(['/symbolicate-jvm', '/symbolicate-jvm']);
	});
});
