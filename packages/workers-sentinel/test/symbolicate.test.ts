import { describe, expect, it } from 'vitest';
import { generateFingerprint } from '../src/lib/fingerprint';
import {
	buildJvmRequest,
	buildNativeRequest,
	mergeJvmResult,
	mergeNativeResult,
	setEventTag,
	symbolicationKinds,
} from '../src/lib/symbolicate';
import type { SentryEvent } from '../src/types';
import { DSYM_DEBUG_ID, jvmEvent, MAPPING_UUID, nativeEvent } from './fixtures/symbolicator/events';
import jvmResponseRaw from './fixtures/symbolicator/jvm-response.json?raw';
import nativeResponseRaw from './fixtures/symbolicator/native-response.json?raw';

const nativeResponse = JSON.parse(nativeResponseRaw);
const jvmResponse = JSON.parse(jvmResponseRaw);

type Json = Record<string, unknown>;
const frames = (holder: unknown): Json[] =>
	((holder as Json).stacktrace as { frames: Json[] }).frames;

describe('symbolication requests and merges', () => {
	it('detects which symbolication an event can use', () => {
		expect(symbolicationKinds(nativeEvent())).toEqual({ native: true, jvm: false });
		expect(symbolicationKinds(jvmEvent())).toEqual({ native: false, jvm: true });
		expect(symbolicationKinds({ message: 'hi' })).toEqual({ native: false, jvm: false });
		// Debug images but no addressed frames: nothing to do natively.
		const noFrames = nativeEvent();
		delete noFrames.exception;
		delete noFrames.threads;
		expect(symbolicationKinds(noFrames).native).toBe(false);
	});

	it('builds a native request: callee-first frames, normalized modules, project source', () => {
		const plan = buildNativeRequest(nativeEvent(), 'proj-1');
		expect(plan).not.toBeNull();
		const body = plan?.body as Json;
		expect(body.sources).toEqual([
			{
				type: 'sentry',
				id: 'sentinel',
				url: 'http://sentinel.internal/dif/proj-1/',
				token: 'internal',
			},
		]);
		const modules = body.modules as Json[];
		expect(modules[0]).toMatchObject({
			type: 'macho',
			debug_id: DSYM_DEBUG_ID,
			image_addr: '0x104b2c000',
		});
		const [exceptionTrace, threadTrace] = body.stacktraces as Array<{
			frames: Json[];
			registers?: Json;
		}>;
		// The `<redacted>` frame has no address and is not sent; order is reversed.
		expect(exceptionTrace.frames.map((f) => f.instruction_addr)).toEqual([
			'0x104b2c464',
			'0x104b2c47c',
			'0x104b2c4b0',
			'0x19a000100',
		]);
		expect(exceptionTrace.registers).toEqual({ pc: '0x104b2c464' });
		expect(threadTrace.frames).toHaveLength(1);
		expect((body.options as Json).frame_order).toBe('callee_first');
	});

	it('merges a recorded Symbolicator answer back into caller-first frames', () => {
		const event = nativeEvent();
		const plan = buildNativeRequest(event, 'proj-1');
		if (!plan) throw new Error('no plan');
		const count = mergeNativeResult(event, plan, nativeResponse);
		expect(count).toBe(4); // 3 exception frames + 1 thread frame

		const exception = (event.exception as { values: Json[] }).values[0];
		const merged = frames(exception);
		expect(merged.map((f) => f.function)).toEqual([
			undefined, // libdyld: no debug file
			'main',
			'<redacted>', // not sent, kept in place
			'middle',
			'crash_here',
		]);
		expect(merged[4]).toMatchObject({
			filename: 'crash.c',
			lineno: 2,
			instruction_addr: '0x104b2c464',
			in_app: true,
			data: { symbolicated: true },
		});
		expect(merged[0].data).toEqual({ symbolicator_status: 'missing' });
		// The original trace is kept, untouched.
		const raw = (exception.raw_stacktrace as { frames: Json[] }).frames;
		expect(raw).toHaveLength(5);
		expect(raw[4].function).toBeUndefined();

		const thread = (event.threads as { values: Json[] }).values[0];
		expect(frames(thread)[0].function).toBe('main');

		const images = (event.debug_meta as { images: Json[] }).images;
		expect(images.map((image) => image.debug_status)).toEqual(['found', 'missing']);
	});

	it('expands an inlined frame into several, outermost first', () => {
		const event = nativeEvent();
		const plan = buildNativeRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		const answer = structuredClone(nativeResponse);
		// Symbolicator lists the inlined callee before its caller (callee-first).
		answer.stacktraces[0].frames.splice(0, 0, {
			...answer.stacktraces[0].frames[0],
			function: 'inlined_helper',
			lineno: 99,
		});
		mergeNativeResult(event, plan, answer);
		const merged = frames((event.exception as { values: Json[] }).values[0]);
		expect(merged.map((f) => f.function).slice(-2)).toEqual(['crash_here', 'inlined_helper']);
	});

	it('groups native crashes by the symbolicated frames', () => {
		const before = nativeEvent();
		const after = nativeEvent();
		const plan = buildNativeRequest(after, 'p');
		if (!plan) throw new Error('no plan');
		mergeNativeResult(after, plan, nativeResponse);
		const otherAfter = nativeEvent();
		const otherPlan = buildNativeRequest(otherAfter, 'p');
		if (!otherPlan) throw new Error('no plan');
		const otherAnswer = structuredClone(nativeResponse);
		otherAnswer.stacktraces[0].frames[0].function = 'another_crash_site';
		mergeNativeResult(otherAfter, otherPlan, otherAnswer);

		const fp = (event: Json) => generateFingerprint(event as unknown as SentryEvent);
		expect(fp(after)).not.toBe(fp(before));
		expect(fp(after)).not.toBe(fp(otherAfter));
	});

	it('builds a JVM request and deobfuscates frames and the exception type', () => {
		const event = jvmEvent();
		const plan = buildJvmRequest(event, 'proj-2');
		if (!plan) throw new Error('no plan');
		const body = plan.body as Json;
		expect(body.modules).toEqual([{ type: 'proguard', uuid: MAPPING_UUID }]);
		expect(body.exceptions).toEqual([{ type: 'b', module: 'a' }]);
		expect((body.options as Json).frame_order).toBe('caller_first');

		const count = mergeJvmResult(plan, jvmResponse);
		expect(count).toBe(2);
		const exception = (event.exception as { values: Json[] }).values[0];
		expect(exception).toMatchObject({
			type: 'BoomException',
			module: 'io.sentinel.sample',
			raw_type: 'b',
			raw_module: 'a',
		});
		expect(frames(exception).map((f) => [f.module, f.function, f.lineno, f.in_app])).toEqual([
			['android.os.Handler', 'run', 5, false],
			['io.sentinel.sample.MainActivity', 'onCreate', 10, true],
			['io.sentinel.sample.MainActivity', 'crash', 20, true],
		]);
		expect((exception.raw_stacktrace as { frames: Json[] }).frames[2].function).toBe('b');
	});

	it('sets tags on object and pair-list tags', () => {
		const objectTags: Json = { tags: { a: '1' } };
		setEventTag(objectTags, 'symbolication', 'failed');
		expect(objectTags.tags).toEqual({ a: '1', symbolication: 'failed' });
		const pairTags: Json = {
			tags: [
				['symbolication', 'x'],
				['b', '2'],
			],
		};
		setEventTag(pairTags, 'symbolication', 'done');
		expect(pairTags.tags).toEqual([
			['b', '2'],
			['symbolication', 'done'],
		]);
		const none: Json = {};
		setEventTag(none, 'k', 'v');
		expect(none.tags).toEqual({ k: 'v' });
	});
});
