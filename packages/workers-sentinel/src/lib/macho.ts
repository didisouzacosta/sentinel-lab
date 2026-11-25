/**
 * Minimal Mach-O reader for debug files: enough to tell a dSYM companion
 * file from anything else, list its architectures and read each one's
 * `LC_UUID` (the debug id Apple crash reports and SDK `debug_meta` carry).
 *
 * Only headers and load commands are read, so callers pass the first bytes
 * of the file (thin) or of each slice (fat). Nothing here allocates more
 * than the input.
 */

const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

/** `filetype` of a dSYM companion file. */
export const MH_DSYM = 0xa;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARCH_ABI64_32 = 0x02000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;

/** Bytes a caller should read per slice so the load commands are covered in practice. */
export const MACHO_HEADER_READ_BYTES = 256 * 1024;

export interface FatSlice {
	offset: number;
	size: number;
}

export interface MachOObject {
	/** Lowercase dashed UUID from `LC_UUID`, or null when the object has none. */
	uuid: string | null;
	arch: string;
	fileType: number;
	/** The object carries a `__DWARF` segment (dSYMs always do). */
	hasDwarf: boolean;
}

export type MachOKind = { kind: 'thin' } | { kind: 'fat'; slices: FatSlice[] } | { kind: 'none' };

function u32(view: DataView, offset: number, little: boolean): number {
	return view.getUint32(offset, little);
}

/** Classify the first bytes of a file: thin Mach-O, fat (universal) archive, or neither. */
export function machOKind(bytes: Uint8Array): MachOKind {
	if (bytes.length < 8) return { kind: 'none' };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0, false);
	if (magic === MH_MAGIC || magic === MH_CIGAM || magic === MH_MAGIC_64 || magic === MH_CIGAM_64) {
		return { kind: 'thin' };
	}
	if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
		const is64 = magic === FAT_MAGIC_64;
		const count = view.getUint32(4, false);
		// Java class files share 0xcafebabe; their "count" is a version
		// number far above any real architecture count.
		if (count === 0 || count > 32) return { kind: 'none' };
		const entrySize = is64 ? 32 : 20;
		if (bytes.length < 8 + count * entrySize) return { kind: 'none' };
		const slices: FatSlice[] = [];
		for (let i = 0; i < count; i++) {
			const base = 8 + i * entrySize;
			if (is64) {
				const offset = Number(view.getBigUint64(base + 8, false));
				const size = Number(view.getBigUint64(base + 16, false));
				slices.push({ offset, size });
			} else {
				slices.push({
					offset: view.getUint32(base + 8, false),
					size: view.getUint32(base + 12, false),
				});
			}
		}
		return { kind: 'fat', slices };
	}
	return { kind: 'none' };
}

function archName(cpuType: number, cpuSubtype: number): string {
	const sub = cpuSubtype & 0x00ffffff;
	if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64)) return sub === 2 ? 'arm64e' : 'arm64';
	if (cpuType === (CPU_TYPE_ARM | CPU_ARCH_ABI64_32)) return 'arm64_32';
	if (cpuType === (CPU_TYPE_X86 | CPU_ARCH_ABI64)) return sub === 8 ? 'x86_64h' : 'x86_64';
	if (cpuType === CPU_TYPE_X86) return 'x86';
	if (cpuType === CPU_TYPE_ARM) {
		if (sub === 9) return 'armv7';
		if (sub === 11) return 'armv7s';
		if (sub === 12) return 'armv7k';
		return 'arm';
	}
	return 'unknown';
}

function formatUuid(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parse one thin Mach-O object from its first bytes. Returns null when the
 * bytes are not a Mach-O header. Load commands past the end of `bytes` are
 * ignored (a missing UUID then reads as null).
 */
export function parseMachO(bytes: Uint8Array): MachOObject | null {
	if (bytes.length < 28) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magicBE = view.getUint32(0, false);
	let little: boolean;
	let is64: boolean;
	if (magicBE === MH_MAGIC || magicBE === MH_MAGIC_64) {
		little = false;
		is64 = magicBE === MH_MAGIC_64;
	} else if (magicBE === MH_CIGAM || magicBE === MH_CIGAM_64) {
		little = true;
		is64 = magicBE === MH_CIGAM_64;
	} else {
		return null;
	}
	const cpuType = u32(view, 4, little);
	const cpuSubtype = u32(view, 8, little);
	const fileType = u32(view, 12, little);
	const ncmds = u32(view, 16, little);
	let offset = is64 ? 32 : 28;
	let uuid: string | null = null;
	let hasDwarf = false;
	for (let i = 0; i < ncmds && offset + 8 <= bytes.length; i++) {
		const cmd = u32(view, offset, little);
		const cmdsize = u32(view, offset + 4, little);
		if (cmdsize < 8) break;
		if (cmd === LC_UUID && offset + 24 <= bytes.length) {
			uuid = formatUuid(bytes.subarray(offset + 8, offset + 24));
		} else if ((cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) && offset + 24 <= bytes.length) {
			const name = new TextDecoder()
				.decode(bytes.subarray(offset + 8, offset + 24))
				.replace(/\0+$/, '');
			if (name === '__DWARF') hasDwarf = true;
		}
		offset += cmdsize;
	}
	return { uuid, arch: archName(cpuType, cpuSubtype), fileType, hasDwarf };
}
