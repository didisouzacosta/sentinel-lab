import { normalizeDebugId } from './debug-files';

/**
 * Event symbolication with Symbolicator (getsentry/symbolicator, running in a
 * Cloudflare Container — src/symbolicator.ts). Pure request builders and
 * result mergers, so the queue consumer stays small and this file is unit
 * tested without a container.
 *
 * - Native (Apple): `debug_meta.images` of type macho → `POST /symbolicate`.
 *   Frames go callee-first (Symbolicator's `original_index` then lines up
 *   with the request) and come back reversed into the event's caller-first
 *   order. Inlined functions expand one frame into several.
 * - JVM (Android): `debug_meta.images` of type proguard → `POST
 *   /symbolicate-jvm`, which also deobfuscates exception types.
 *
 * Symbolicator finds files through one "sentry" source per request,
 * `http://sentinel.internal/dif/{projectId}/`, answered by the Worker from R2
 * (the container has no internet). The original stack trace is kept in
 * `raw_stacktrace`, like Sentry does.
 */

/** Hostname the container uses to reach the Worker (outbound interception). */
export const DIF_SOURCE_HOST = 'sentinel.internal';

export function difSourceUrl(projectId: string): string {
	return `http://${DIF_SOURCE_HOST}/dif/${projectId}/`;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One `stacktrace` slot of an event: an exception, a thread or the event itself. */
interface StackSlot {
	holder: Json;
	frames: Json[];
	exception: Json | null;
}

function threadValues(event: Json): Json[] {
	const threads = event.threads;
	const values = Array.isArray(threads) ? threads : isObject(threads) ? threads.values : null;
	return Array.isArray(values) ? values.filter(isObject) : [];
}

function exceptionValues(event: Json): Json[] {
	const exception = event.exception;
	const values = Array.isArray(exception)
		? exception
		: isObject(exception)
			? exception.values
			: null;
	return Array.isArray(values) ? values.filter(isObject) : [];
}

function stackSlots(event: Json): StackSlot[] {
	const slots: StackSlot[] = [];
	const add = (holder: Json, exception: Json | null) => {
		const stacktrace = holder.stacktrace;
		if (!isObject(stacktrace) || !Array.isArray(stacktrace.frames)) return;
		const frames = stacktrace.frames.filter(isObject);
		if (frames.length === 0) return;
		slots.push({ holder, frames, exception });
	};
	for (const exception of exceptionValues(event)) add(exception, exception);
	for (const thread of threadValues(event)) add(thread, null);
	add(event, null);
	return slots;
}

function debugImages(event: Json): Json[] {
	const meta = event.debug_meta;
	const images = isObject(meta) ? meta.images : null;
	return Array.isArray(images) ? images.filter(isObject) : [];
}

function isNativeImage(image: Json): boolean {
	return image.type === 'macho' || image.type === 'apple' || image.type === 'symbolic';
}

function imageDebugId(image: Json): string | null {
	return normalizeDebugId(image.debug_id ?? image.uuid);
}

/** Which kinds of symbolication an event can use, from its `debug_meta`. */
export function symbolicationKinds(event: unknown): { native: boolean; jvm: boolean } {
	if (!isObject(event)) return { native: false, jvm: false };
	const images = debugImages(event);
	const native =
		images.some((image) => isNativeImage(image) && imageDebugId(image)) &&
		stackSlots(event).some((slot) => slot.frames.some(hasAddress));
	const jvm =
		images.some((image) => image.type === 'proguard' && imageDebugId(image)) &&
		stackSlots(event).length > 0;
	return { native, jvm };
}

// Symbolicator rejects a whole request (422) when a single field has the
// wrong shape, and every field here comes from the SDK, i.e. from anyone
// holding the (public) DSN. Only values of the exact accepted shape are
// forwarded; anything else is left out (test/symbolicate-hardening.test.ts).

const HEX_U64 = /^0x[0-9a-f]{1,16}$/i;
/** Longest string forwarded for names and paths. */
const MAX_FIELD_CHARS = 1024;

/** An address Symbolicator accepts: a u64 as `0x…` hex or a safe non-negative integer. */
function address(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return `0x${value.toString(16)}`;
	}
	if (typeof value === 'string' && HEX_U64.test(value)) return value.toLowerCase();
	return undefined;
}

function hasAddress(frame: Json): boolean {
	return address(frame.instruction_addr) !== undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length <= MAX_FIELD_CHARS ? value : undefined;
}

/** Copy the keys whose values are strings Symbolicator accepts. */
function pickText(source: Json, keys: string[]): Json {
	const out: Json = {};
	for (const key of keys) {
		const value = text(source[key]);
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Copy present keys (for Symbolicator's own answers). */
function pick(source: Json, keys: string[]): Json {
	const out: Json = {};
	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
	}
	return out;
}

function u32(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
		? value
		: undefined;
}

// ---------------------------------------------------------------------------
// Native
// ---------------------------------------------------------------------------

interface NativeSlotPlan {
	slot: StackSlot;
	/** Positions (in the event's caller-first frames) sent, callee-first. */
	positions: number[];
}

export interface NativePlan {
	body: Json;
	slots: NativeSlotPlan[];
	/** Index in `debug_meta.images` of each module sent. */
	imageIndexes: number[];
}

export function buildNativeRequest(event: Json, projectId: string): NativePlan | null {
	const images = debugImages(event);
	const modules: Json[] = [];
	const imageIndexes: number[] = [];
	/** Event image index → index in `modules`, for `rel:N` addressing. */
	const moduleIndexOf = new Map<number, number>();
	images.forEach((image, index) => {
		if (!isNativeImage(image)) return;
		const debugId = imageDebugId(image);
		const imageAddr = address(image.image_addr);
		if (!debugId || imageAddr === undefined) return;
		const vmaddr = address(image.image_vmaddr);
		const size = image.image_size;
		moduleIndexOf.set(index, modules.length);
		modules.push({
			...pickText(image, ['code_id', 'code_file', 'debug_file', 'arch']),
			type: 'macho',
			debug_id: debugId,
			image_addr: imageAddr,
			...(Number.isSafeInteger(size) && (size as number) >= 0 ? { image_size: size } : {}),
			...(vmaddr !== undefined ? { image_vmaddr: vmaddr } : {}),
		});
		imageIndexes.push(index);
	});
	if (modules.length === 0) return null;

	/** The frame as sent, or null when Symbolicator could not take it. */
	const requestFrame = (frame: Json): Json | null => {
		const instructionAddr = address(frame.instruction_addr);
		if (instructionAddr === undefined) return null;
		const out: Json = { ...pickText(frame, ['function', 'package', 'trust']) };
		if (typeof frame.addr_mode === 'string') {
			if (frame.addr_mode === 'abs') {
				out.addr_mode = 'abs';
			} else {
				const rel = /^rel:(\d{1,6})$/.exec(frame.addr_mode);
				const target = rel ? moduleIndexOf.get(Number(rel[1])) : undefined;
				if (target === undefined) return null; // relative to an image not sent
				out.addr_mode = `rel:${target}`;
			}
		}
		out.instruction_addr = instructionAddr;
		return out;
	};

	const slots: NativeSlotPlan[] = [];
	const stacktraces: Json[] = [];
	for (const slot of stackSlots(event)) {
		const positions: number[] = [];
		const frames: Json[] = [];
		for (let i = slot.frames.length - 1; i >= 0; i--) {
			const sent = requestFrame(slot.frames[i]);
			if (!sent) continue;
			positions.push(i);
			frames.push(sent);
		}
		if (positions.length === 0) continue;
		const stacktrace = slot.holder.stacktrace as Json;
		const registers: Json = {};
		if (isObject(stacktrace.registers)) {
			for (const [name, value] of Object.entries(stacktrace.registers)) {
				const sent = address(value);
				if (sent !== undefined && name.length <= 32) registers[name] = sent;
			}
		}
		stacktraces.push({
			frames,
			...(Object.keys(registers).length > 0 ? { registers } : {}),
		});
		slots.push({ slot, positions });
	}
	if (slots.length === 0) return null;

	return {
		body: {
			platform: event.platform === 'cocoa' ? 'cocoa' : 'native',
			sources: [
				{ type: 'sentry', id: 'sentinel', url: difSourceUrl(projectId), token: 'internal' },
			],
			stacktraces,
			modules,
			options: { dif_candidates: false, apply_source_context: false, frame_order: 'callee_first' },
		},
		slots,
		imageIndexes,
	};
}

const NATIVE_RESULT_FIELDS = [
	'function',
	'symbol',
	'filename',
	'abs_path',
	'lineno',
	'colno',
	'lang',
];

/**
 * Merge a `/symbolicate` answer into the event (in place). Returns how many
 * frames were symbolicated.
 */
export function mergeNativeResult(event: Json, plan: NativePlan, result: Json): number {
	const stacktraces = Array.isArray(result.stacktraces) ? result.stacktraces : [];
	let symbolicated = 0;
	plan.slots.forEach((slotPlan, slotIndex) => {
		const answered = stacktraces[slotIndex];
		const outFrames = isObject(answered) && Array.isArray(answered.frames) ? answered.frames : [];
		// Group answered frames by the request frame they came from
		// (callee-first, inlined callees before their caller).
		const groups = new Map<number, Json[]>();
		for (const out of outFrames) {
			if (!isObject(out) || typeof out.original_index !== 'number') continue;
			const list = groups.get(out.original_index) ?? [];
			list.push(out);
			groups.set(out.original_index, list);
		}
		const requestIndexOf = new Map<number, number>();
		slotPlan.positions.forEach((position, requestIndex) => {
			requestIndexOf.set(position, requestIndex);
		});

		const { slot } = slotPlan;
		const merged: Json[] = [];
		let changed = false;
		slot.frames.forEach((frame, position) => {
			const requestIndex = requestIndexOf.get(position);
			const group = requestIndex === undefined ? undefined : groups.get(requestIndex);
			if (!group || group.length === 0) {
				merged.push(frame);
				return;
			}
			// Back to caller-first: the group's last entry is the outermost.
			for (const out of [...group].reverse()) {
				if (out.status !== 'symbolicated') {
					merged.push({
						...frame,
						data: { ...(isObject(frame.data) ? frame.data : {}), symbolicator_status: out.status },
					});
					continue;
				}
				symbolicated++;
				changed = true;
				merged.push({
					...frame,
					...pick(out, NATIVE_RESULT_FIELDS),
					...(out.sym_addr !== undefined ? { symbol_addr: out.sym_addr } : {}),
					...(typeof out.package === 'string' ? { package: out.package } : {}),
					data: { ...(isObject(frame.data) ? frame.data : {}), symbolicated: true },
				});
			}
		});
		if (changed) replaceStacktrace(slot, merged);
	});

	const modules = Array.isArray(result.modules) ? result.modules : [];
	const images = debugImages(event);
	plan.imageIndexes.forEach((imageIndex, moduleIndex) => {
		const module = modules[moduleIndex];
		const image = images[imageIndex];
		if (isObject(module) && image && typeof module.debug_status === 'string') {
			image.debug_status = module.debug_status;
		}
	});
	return symbolicated;
}

function replaceStacktrace(slot: StackSlot, frames: Json[]): void {
	const original = slot.holder.stacktrace as Json;
	if (slot.holder.raw_stacktrace === undefined) slot.holder.raw_stacktrace = original;
	slot.holder.stacktrace = { ...original, frames };
}

// ---------------------------------------------------------------------------
// JVM (ProGuard / R8)
// ---------------------------------------------------------------------------

export interface JvmPlan {
	body: Json;
	slots: StackSlot[];
	exceptions: Json[];
}

/** An exception Symbolicator accepts (`type` and `module` are both required). */
function jvmException(exception: Json): Json | null {
	const type = text(exception.type);
	const module = text(exception.module);
	return type !== undefined && module !== undefined ? { type, module } : null;
}

/** A frame Symbolicator accepts (`function` and `module` required, `lineno` a u32). */
function jvmFrame(frame: Json, index: number): Json | null {
	const fn = text(frame.function);
	const module = text(frame.module);
	if (fn === undefined || module === undefined) return null;
	const lineno = u32(frame.lineno);
	return {
		function: fn,
		module,
		...pickText(frame, ['filename', 'abs_path']),
		...(lineno !== undefined ? { lineno } : {}),
		...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {}),
		index,
	};
}

export function buildJvmRequest(event: Json, projectId: string): JvmPlan | null {
	const modules = debugImages(event)
		.filter((image) => image.type === 'proguard')
		.map(imageDebugId)
		.filter((id): id is string => id !== null)
		.map((uuid) => ({ type: 'proguard', uuid }));
	if (modules.length === 0) return null;

	const exceptions: Json[] = [];
	const exceptionRefs: Json[] = [];
	for (const exception of exceptionValues(event)) {
		const ref = jvmException(exception);
		if (!ref) continue;
		exceptions.push(exception);
		exceptionRefs.push(ref);
	}
	const slots: StackSlot[] = [];
	const stacktraces: Json[] = [];
	for (const slot of stackSlots(event)) {
		const frames = slot.frames
			.map((frame, index) => jvmFrame(frame, index))
			.filter((frame): frame is Json => frame !== null);
		if (frames.length === 0) continue;
		const exceptionRef = slot.exception ? jvmException(slot.exception) : null;
		slots.push(slot);
		stacktraces.push({ ...(exceptionRef ? { exception: exceptionRef } : {}), frames });
	}
	if (slots.length === 0 && exceptions.length === 0) return null;

	return {
		body: {
			platform: 'java',
			sources: [
				{ type: 'sentry', id: 'sentinel', url: difSourceUrl(projectId), token: 'internal' },
			],
			exceptions: exceptionRefs,
			stacktraces,
			modules,
			classes: [],
			options: { apply_source_context: false, frame_order: 'caller_first' },
		},
		slots,
		exceptions,
	};
}

/** Merge a `/symbolicate-jvm` answer into the event (in place). Returns frames remapped. */
export function mergeJvmResult(plan: JvmPlan, result: Json): number {
	const answeredExceptions = Array.isArray(result.exceptions) ? result.exceptions : [];
	plan.exceptions.forEach((exception, index) => {
		const answered = answeredExceptions[index];
		if (!isObject(answered)) return;
		if (typeof answered.type === 'string' && answered.type !== exception.type) {
			exception.raw_type = exception.type;
			exception.type = answered.type;
		}
		if (typeof answered.module === 'string' && answered.module !== exception.module) {
			exception.raw_module = exception.module;
			exception.module = answered.module;
		}
	});

	const stacktraces = Array.isArray(result.stacktraces) ? result.stacktraces : [];
	let remapped = 0;
	plan.slots.forEach((slot, slotIndex) => {
		const answered = stacktraces[slotIndex];
		const outFrames = isObject(answered) && Array.isArray(answered.frames) ? answered.frames : [];
		const groups = new Map<number, Json[]>();
		for (const out of outFrames) {
			if (!isObject(out) || typeof out.index !== 'number') continue;
			const list = groups.get(out.index) ?? [];
			list.push(out);
			groups.set(out.index, list);
		}
		const merged: Json[] = [];
		let changed = false;
		slot.frames.forEach((frame, index) => {
			const group = groups.get(index);
			if (!group || group.length === 0) {
				merged.push(frame);
				return;
			}
			for (const out of group) {
				const next: Json = { ...frame };
				for (const key of ['function', 'module', 'filename', 'abs_path', 'lineno']) {
					if (out[key] !== undefined) next[key] = out[key];
				}
				if (
					next.function !== frame.function ||
					next.module !== frame.module ||
					next.lineno !== frame.lineno ||
					group.length > 1
				) {
					changed = true;
					remapped++;
					next.data = { ...(isObject(frame.data) ? frame.data : {}), symbolicated: true };
				}
				merged.push(next);
			}
		});
		if (changed) replaceStacktrace(slot, merged);
	});
	return remapped;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Set a tag on an event whose `tags` may be an object or Sentry's `[key, value][]`. */
export function setEventTag(event: Json, key: string, value: string): void {
	const tags = event.tags;
	if (Array.isArray(tags)) {
		const filtered = tags.filter((pair) => !(Array.isArray(pair) && pair[0] === key));
		filtered.push([key, value]);
		event.tags = filtered;
		return;
	}
	event.tags = { ...(isObject(tags) ? tags : {}), [key]: value };
}
