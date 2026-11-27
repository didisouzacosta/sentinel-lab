import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Cache of Symbolicator answers (docs/plano-riscos-simbolizacao.md, phase
 * 4): the same crash from many devices costs one container call.
 *
 * The key is the request with its addresses made relative to the image
 * they fall in: ASLR loads the binary at a different address on every run,
 * so the absolute addresses of one crash never repeat, while the offsets
 * do. ProjectState also adds the ids of the stored debug files the request
 * can use (an upload or delete changes the key, so a "missing" answer from
 * before a dSYM upload is never reused after it). Entries live in the
 * project's ProjectState for 24 hours.
 *
 * On a hit, the only address the merge copies from the answer
 * (`sym_addr` → `symbol_addr`) is rebased onto the current image address.
 */

type Json = Record<string, unknown>;

export type SymbolicatorPath = '/symbolicate' | '/symbolicate-jvm';

export interface CacheKey {
	/** sha256 hex of the normalized request. */
	key: string;
	/** Debug ids the request can use (ProjectState adds their stored file ids to the key). */
	debugIds: string[];
	/** Native only: image address of each module, in request order. */
	bases: string[];
	/** Native only: module index of each request frame, per stacktrace (-1: none). */
	frameModules: number[][];
}

/** What is stored for a key. */
export interface CachedAnswer {
	result: Json;
	bases: string[];
}

function big(hex: unknown): bigint | null {
	if (typeof hex !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(hex)) return null;
	return BigInt(hex);
}

function hexOf(value: bigint): string {
	return `0x${value.toString(16)}`;
}

/** Index of the module an absolute address falls in, or -1. */
function moduleOf(addr: bigint, modules: Json[]): number {
	let best = -1;
	let bestBase = -1n;
	modules.forEach((module, index) => {
		const base = big(module.image_addr);
		if (base === null || base > addr) return;
		const size = typeof module.image_size === 'number' ? BigInt(module.image_size) : null;
		if (size !== null && addr >= base + size) return;
		if (base > bestBase) {
			best = index;
			bestBase = base;
		}
	});
	return best;
}

function digest(value: unknown): string {
	return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

/**
 * The cache key of a Symbolicator request body as built by
 * lib/symbolicate.ts (sources are left out: the cache is per project).
 */
export function cacheKey(path: SymbolicatorPath, body: Json): CacheKey {
	if (path === '/symbolicate-jvm') {
		const modules = Array.isArray(body.modules) ? (body.modules as Json[]) : [];
		return {
			key: digest({
				path,
				exceptions: body.exceptions,
				stacktraces: body.stacktraces,
				modules,
				options: body.options,
			}),
			debugIds: modules.map((m) => String(m.uuid ?? '')).filter(Boolean),
			bases: [],
			frameModules: [],
		};
	}

	const modules = Array.isArray(body.modules) ? (body.modules as Json[]) : [];
	const bases = modules.map((m) => String(m.image_addr ?? '0x0'));
	const frameModules: number[][] = [];
	const relative = (addrHex: unknown, addrMode: unknown): { m: number; at: string } => {
		const addr = big(addrHex);
		if (addr === null) return { m: -1, at: String(addrHex) };
		const rel = typeof addrMode === 'string' ? /^rel:(\d+)$/.exec(addrMode) : null;
		if (rel) return { m: Number(rel[1]), at: hexOf(addr) }; // already relative
		const m = moduleOf(addr, modules);
		if (m < 0) return { m: -1, at: hexOf(addr) }; // outside every image: stays absolute
		return { m, at: hexOf(addr - (big(modules[m].image_addr) as bigint)) };
	};

	const stacktraces = (Array.isArray(body.stacktraces) ? (body.stacktraces as Json[]) : []).map(
		(st) => {
			const frames = Array.isArray(st.frames) ? (st.frames as Json[]) : [];
			const indexes: number[] = [];
			const normalized = frames.map((frame) => {
				const { m, at } = relative(frame.instruction_addr, frame.addr_mode);
				indexes.push(m);
				return {
					m,
					at,
					mode: frame.addr_mode ?? null,
					fn: frame.function ?? null,
					pkg: frame.package ?? null,
					trust: frame.trust ?? null,
				};
			});
			frameModules.push(indexes);
			const registers: Json = {};
			if (st.registers && typeof st.registers === 'object') {
				for (const [name, value] of Object.entries(st.registers as Json)) {
					const { m, at } = relative(value, undefined);
					registers[name] = `${m}:${at}`;
				}
			}
			return { frames: normalized, registers };
		},
	);

	return {
		key: digest({
			path,
			platform: body.platform,
			// Image addresses are left out on purpose; everything else about a
			// module can change the answer.
			modules: modules.map((m) => ({
				debug_id: m.debug_id,
				code_id: m.code_id ?? null,
				arch: m.arch ?? null,
				image_size: m.image_size ?? null,
				vmaddr: m.image_vmaddr ?? null,
				type: m.type,
			})),
			stacktraces,
			options: body.options,
		}),
		debugIds: modules.map((m) => String(m.debug_id ?? '')).filter(Boolean),
		bases,
		frameModules,
	};
}

/**
 * A cached native answer for the current request: `sym_addr` (and
 * `instruction_addr`) of each answered frame moved by the difference
 * between its module's image address now and when it was cached.
 */
export function rebaseAnswer(cached: CachedAnswer, current: CacheKey): Json {
	const result = structuredClone(cached.result);
	if (current.bases.length === 0) return result; // JVM: nothing to move
	const stacktraces = Array.isArray(result.stacktraces) ? (result.stacktraces as Json[]) : [];
	stacktraces.forEach((st, s) => {
		const frames = Array.isArray(st.frames) ? (st.frames as Json[]) : [];
		for (const frame of frames) {
			const index = typeof frame.original_index === 'number' ? frame.original_index : -1;
			const m = current.frameModules[s]?.[index] ?? -1;
			if (m < 0) continue;
			const now = big(current.bases[m]);
			const then = big(cached.bases[m]);
			if (now === null || then === null) continue;
			const delta = now - then;
			for (const field of ['sym_addr', 'instruction_addr']) {
				const value = big(frame[field]);
				if (value !== null && value + delta >= 0n) frame[field] = hexOf(value + delta);
			}
		}
	});
	return result;
}

/** Answers worth keeping: complete ones, small enough for a ProjectState row. */
export const MAX_CACHED_ANSWER_CHARS = 512 * 1024;
export const SYMBOLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
