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

function hasAddress(frame: Json): boolean {
	return typeof frame.instruction_addr === 'string' || typeof frame.instruction_addr === 'number';
}

function hex(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return `0x${value.toString(16)}`;
	if (typeof value === 'string' && value !== '') return value;
	return undefined;
}

function pick(source: Json, keys: string[]): Json {
	const out: Json = {};
	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
	}
	return out;
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
	images.forEach((image, index) => {
		if (!isNativeImage(image)) return;
		const debugId = imageDebugId(image);
		if (!debugId) return;
		modules.push({
			...pick(image, ['code_id', 'code_file', 'debug_file', 'arch', 'image_size']),
			type: 'macho',
			debug_id: debugId,
			image_addr: hex(image.image_addr) ?? '0x0',
			...(image.image_vmaddr !== undefined ? { image_vmaddr: hex(image.image_vmaddr) } : {}),
		});
		imageIndexes.push(index);
	});
	if (modules.length === 0) return null;

	const slots: NativeSlotPlan[] = [];
	const stacktraces: Json[] = [];
	for (const slot of stackSlots(event)) {
		const positions: number[] = [];
		for (let i = slot.frames.length - 1; i >= 0; i--) {
			if (hasAddress(slot.frames[i])) positions.push(i);
		}
		if (positions.length === 0) continue;
		const stacktrace = slot.holder.stacktrace as Json;
		stacktraces.push({
			frames: positions.map((position) => {
				const frame = slot.frames[position];
				return {
					...pick(frame, ['addr_mode', 'function', 'package', 'trust']),
					instruction_addr: hex(frame.instruction_addr),
				};
			}),
			...(isObject(stacktrace.registers) ? { registers: stacktrace.registers } : {}),
		});
		slots.push({ slot, positions });
	}
	if (slots.length === 0) return null;

	return {
		body: {
			platform: typeof event.platform === 'string' ? event.platform : 'native',
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

const JVM_FRAME_FIELDS = ['function', 'module', 'lineno', 'abs_path', 'filename', 'in_app'];

export function buildJvmRequest(event: Json, projectId: string): JvmPlan | null {
	const modules = debugImages(event)
		.filter((image) => image.type === 'proguard')
		.map(imageDebugId)
		.filter((id): id is string => id !== null)
		.map((uuid) => ({ type: 'proguard', uuid }));
	if (modules.length === 0) return null;

	const exceptions = exceptionValues(event);
	const slots = stackSlots(event);
	if (slots.length === 0 && exceptions.length === 0) return null;
	const exceptionRef = (exception: Json): Json => pick(exception, ['type', 'module']);

	return {
		body: {
			platform: typeof event.platform === 'string' ? event.platform : 'java',
			sources: [
				{ type: 'sentry', id: 'sentinel', url: difSourceUrl(projectId), token: 'internal' },
			],
			exceptions: exceptions.map(exceptionRef),
			stacktraces: slots.map((slot) => ({
				...(slot.exception ? { exception: exceptionRef(slot.exception) } : {}),
				frames: slot.frames.map((frame, index) => ({ ...pick(frame, JVM_FRAME_FIELDS), index })),
			})),
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
