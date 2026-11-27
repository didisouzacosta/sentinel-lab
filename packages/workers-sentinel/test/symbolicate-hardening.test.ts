import { describe, expect, it } from 'vitest';
import {
	buildJvmRequest,
	buildNativeRequest,
	mergeJvmResult,
	mergeNativeResult,
} from '../src/lib/symbolicate';
import { DSYM_DEBUG_ID, jvmEvent, MAPPING_UUID, nativeEvent } from './fixtures/symbolicator/events';

/**
 * Hostile and malformed SDK input. Anyone holding a DSN (public by design)
 * controls every field of an event, and Symbolicator rejects a WHOLE request
 * (422) when one field has the wrong shape. The rules below mirror what
 * Symbolicator 26.11.0 refused when probed (scratch probe against the image
 * in symbolicator/Dockerfile, 2026-11-27):
 *
 * - instruction_addr / image_addr / registers: hex string or non-negative
 *   integer that fits in u64 ("0x-1", "banana", 2^72 → 422)
 * - image_size: non-negative integer ("0x4000", -1 → 422)
 * - code_file, function, filename…: strings (objects/numbers → 422)
 * - JVM frames need string `function` and `module`; `lineno` is a u32
 *   (-1, 1.5, "2" → 422); JVM exceptions need string `type` and `module`.
 */

type Json = Record<string, unknown>;

const HEX_U64 = /^0x[0-9a-f]{1,16}$/i;
const isAddr = (v: unknown) =>
	(typeof v === 'string' && HEX_U64.test(v)) ||
	(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const isU32 = (v: unknown) =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const optString = (o: Json, k: string) => o[k] === undefined || typeof o[k] === 'string';

/** Problems Symbolicator would answer with 422; empty when the body is acceptable. */
function nativeProblems(body: Json): string[] {
	const problems: string[] = [];
	for (const [i, m] of (body.modules as Json[]).entries()) {
		if (!isAddr(m.image_addr)) problems.push(`modules[${i}].image_addr`);
		if (
			m.image_size !== undefined &&
			!(Number.isSafeInteger(m.image_size) && (m.image_size as number) >= 0)
		)
			problems.push(`modules[${i}].image_size`);
		if (m.image_vmaddr !== undefined && !isAddr(m.image_vmaddr))
			problems.push(`modules[${i}].image_vmaddr`);
		for (const k of ['code_id', 'code_file', 'debug_file', 'debug_id', 'arch'])
			if (!optString(m, k)) problems.push(`modules[${i}].${k}`);
	}
	for (const [s, st] of (body.stacktraces as Json[]).entries()) {
		for (const [f, frame] of (st.frames as Json[]).entries()) {
			if (!isAddr(frame.instruction_addr)) problems.push(`st[${s}].frames[${f}].instruction_addr`);
			for (const k of ['function', 'package', 'addr_mode', 'trust'])
				if (!optString(frame, k)) problems.push(`st[${s}].frames[${f}].${k}`);
		}
		for (const [k, v] of Object.entries((st.registers as Json) ?? {}))
			if (!isAddr(v)) problems.push(`st[${s}].registers.${k}`);
	}
	return problems;
}

function jvmProblems(body: Json): string[] {
	const problems: string[] = [];
	const exceptionOk = (e: Json) => typeof e.type === 'string' && typeof e.module === 'string';
	for (const [i, e] of (body.exceptions as Json[]).entries())
		if (!exceptionOk(e)) problems.push(`exceptions[${i}]`);
	for (const [s, st] of (body.stacktraces as Json[]).entries()) {
		if (st.exception !== undefined && !exceptionOk(st.exception as Json))
			problems.push(`st[${s}].exception`);
		for (const [f, frame] of (st.frames as Json[]).entries()) {
			if (typeof frame.function !== 'string' || typeof frame.module !== 'string')
				problems.push(`st[${s}].frames[${f}].function/module`);
			if (frame.lineno !== undefined && !isU32(frame.lineno))
				problems.push(`st[${s}].frames[${f}].lineno`);
			for (const k of ['filename', 'abs_path'])
				if (!optString(frame, k)) problems.push(`st[${s}].frames[${f}].${k}`);
			if (frame.in_app !== undefined && typeof frame.in_app !== 'boolean')
				problems.push(`st[${s}].frames[${f}].in_app`);
		}
	}
	return problems;
}

const exceptionOf = (event: Json) => (event.exception as { values: Json[] }).values[0];
const framesOf = (holder: Json) => (holder.stacktrace as { frames: Json[] }).frames;

describe('symbolication input hardening — native', () => {
	it('never sends a frame Symbolicator would reject, and keeps it in place', () => {
		const event = nativeEvent();
		const frames = framesOf(exceptionOf(event));
		frames.push(
			{ instruction_addr: '0x-1' },
			{ instruction_addr: 'banana' },
			{ instruction_addr: '0x1ffffffffffffffffff' },
			{ instruction_addr: -5 },
			{ instruction_addr: 1.5 },
			{ instruction_addr: { evil: true } },
			{ instruction_addr: '0x104b2c464', function: { evil: true }, package: 42, addr_mode: 7 },
		);
		(exceptionOf(event).stacktrace as Json).registers = { pc: 'nope', lr: '0x104b2c47c', sp: -1 };

		const plan = buildNativeRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		expect(nativeProblems(plan.body)).toEqual([]);
		const sent = (plan.body.stacktraces as Json[])[0].frames as Json[];
		// 4 valid frames from the fixture + the last one (address is valid;
		// its non-string fields are dropped, not the frame).
		expect(sent).toHaveLength(5);
		expect(sent[0]).toEqual({ instruction_addr: '0x104b2c464' });
		expect((plan.body.stacktraces as Json[])[0].registers).toEqual({ lr: '0x104b2c47c' });
	});

	it('skips modules with unusable addresses and drops malformed module fields', () => {
		const event = nativeEvent();
		const images = (event.debug_meta as { images: Json[] }).images;
		images[0].image_size = '0x4000';
		images[0].code_file = { evil: true };
		images[0].arch = 42;
		images[1].image_addr = 'zzz';
		images.push({
			type: 'macho',
			debug_id: 'eeeeeeee-0000-1111-2222-333333333333',
			image_size: 100,
		});

		const plan = buildNativeRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		expect(nativeProblems(plan.body)).toEqual([]);
		const modules = plan.body.modules as Json[];
		expect(modules.map((m) => m.debug_id)).toEqual([DSYM_DEBUG_ID]);
		expect(modules[0]).not.toHaveProperty('image_size');
		expect(modules[0]).not.toHaveProperty('code_file');
		expect(plan.imageIndexes).toEqual([0]);
	});

	it('remaps rel:N addressing to the filtered module list', () => {
		const event = nativeEvent();
		const images = (event.debug_meta as { images: Json[] }).images;
		// Event images: [proguard, bad macho, the dSYM] → only the dSYM is sent (index 0).
		images.unshift({ type: 'macho', debug_id: 'not-a-uuid', image_addr: '0x1' });
		images.unshift({ type: 'proguard', uuid: MAPPING_UUID });
		const frames = framesOf(exceptionOf(event));
		frames.length = 0;
		frames.push(
			{ instruction_addr: '0x464', addr_mode: 'rel:2' }, // the dSYM
			{ instruction_addr: '0x10', addr_mode: 'rel:1' }, // image not sent
			{ instruction_addr: '0x10', addr_mode: 'rel:99' }, // no such image
			{ instruction_addr: '0x104b2c464', addr_mode: 'abs' },
		);
		const plan = buildNativeRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		const sent = (plan.body.stacktraces as Json[])[0].frames as Json[];
		// Callee-first: abs frame, then the rel:2 frame remapped to rel:0.
		expect(sent).toEqual([
			{ instruction_addr: '0x104b2c464', addr_mode: 'abs' },
			{ instruction_addr: '0x464', addr_mode: 'rel:0' },
		]);
	});

	it('ignores answers that reference frames it did not send', () => {
		const event = nativeEvent();
		const plan = buildNativeRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		const before = JSON.stringify(framesOf(exceptionOf(event)));
		const merged = mergeNativeResult(event, plan, {
			stacktraces: [
				{
					frames: [
						{ original_index: 99, status: 'symbolicated', function: 'ghost' },
						{ original_index: -1, status: 'symbolicated', function: 'ghost' },
						{ original_index: '0', status: 'symbolicated', function: 'ghost' },
						'not a frame',
					],
				},
			],
			modules: 'nope',
		});
		expect(merged).toBe(0);
		expect(JSON.stringify(framesOf(exceptionOf(event)))).toBe(before);
	});
});

describe('symbolication input hardening — JVM', () => {
	it('sends only frames and exceptions Symbolicator accepts, and maps answers back by index', () => {
		const event = jvmEvent();
		const values = (event.exception as { values: Json[] }).values;
		const frames = framesOf(values[0]);
		frames.unshift(
			{ function: 'nativeCrash', in_app: false }, // NDK frame: no module
			{ module: 'a.a', lineno: 3 }, // no function
			{ function: 'a', module: 'a.a', lineno: -1, filename: 7, in_app: 'yes' },
			{ function: 'a', module: 'a.a', lineno: 1.5 },
		);
		values.unshift({ type: 'Wrapper', value: 'no module here' });

		const plan = buildJvmRequest(event, 'p');
		if (!plan) throw new Error('no plan');
		expect(jvmProblems(plan.body)).toEqual([]);
		const sentFrames = (plan.body.stacktraces as Json[]).flatMap((st) => st.frames as Json[]);
		expect(sentFrames.map((f) => f.index)).toEqual([2, 3, 4, 5, 6]);
		expect(sentFrames[0]).toEqual({ function: 'a', module: 'a.a', index: 2 });
		expect(plan.body.exceptions).toEqual([{ type: 'b', module: 'a' }]);

		// An answer for the sent exception and frames lands on the right ones.
		mergeJvmResult(plan, {
			exceptions: [{ type: 'BoomException', module: 'io.sentinel.sample' }],
			stacktraces: (plan.body.stacktraces as Json[]).map((st) => ({
				frames: (st.frames as Json[]).map((f) => ({
					...f,
					function: `real_${String(f.function)}`,
				})),
			})),
		});
		expect(values[0]).toMatchObject({ type: 'Wrapper' });
		expect(values[1]).toMatchObject({ type: 'BoomException', raw_type: 'b' });
		const merged = framesOf(values[1]);
		expect(merged[0].function).toBe('nativeCrash');
		expect(merged[1].function).toBeUndefined();
		expect(merged[2].function).toBe('real_a');
	});

	it('does nothing when no exception or frame is usable', () => {
		const event = {
			platform: 'java',
			exception: { values: [{ type: 'X', stacktrace: { frames: [{ function: 'f' }] } }] },
			debug_meta: { images: [{ type: 'proguard', uuid: MAPPING_UUID }] },
		};
		expect(buildJvmRequest(event, 'p')).toBeNull();
	});
});
