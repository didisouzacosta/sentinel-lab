/**
 * Events shaped like the Sentry Cocoa / Android SDKs send them, built
 * against test/fixtures/dif: `crashdemo-arm64.dsym` (crash.c) and
 * `mapping-lines.txt`. The `*-response.json` files next to this one are
 * what Symbolicator 26.11.0 answered for these events (recorded once, with
 * the image from symbolicator/Dockerfile and a fake "sentry" source serving
 * the fixtures).
 */

export const DSYM_DEBUG_ID = '50b959c2-7066-33ae-8751-88bd95371d96';
export const MAPPING_UUID = '11111111-2222-3333-4444-555555555555';
export const IMAGE_ADDR = 0x104b2c000;

const addr = (offset: number) => `0x${(IMAGE_ADDR + offset).toString(16)}`;

/** Native crash: main → middle → crash_here (caller first), plus a system frame. */
export function nativeEvent(): Record<string, unknown> {
	return {
		event_id: 'a'.repeat(32),
		platform: 'cocoa',
		level: 'fatal',
		exception: {
			values: [
				{
					type: 'EXC_BAD_ACCESS',
					value: 'KERN_INVALID_ADDRESS at 0x0',
					stacktrace: {
						frames: [
							{
								instruction_addr: '0x19a000100',
								package: '/usr/lib/system/libdyld.dylib',
								in_app: false,
							},
							{
								instruction_addr: addr(0x4b0),
								package: '/private/var/containers/Bundle/Application/X/CrashDemo.app/CrashDemo',
								in_app: true,
							},
							{ function: '<redacted>', in_app: false },
							{
								instruction_addr: addr(0x47c),
								package: '/private/var/containers/Bundle/Application/X/CrashDemo.app/CrashDemo',
								in_app: true,
							},
							{
								instruction_addr: addr(0x464),
								package: '/private/var/containers/Bundle/Application/X/CrashDemo.app/CrashDemo',
								in_app: true,
							},
						],
						registers: { pc: addr(0x464) },
					},
				},
			],
		},
		threads: {
			values: [
				{
					id: 1,
					crashed: false,
					stacktrace: { frames: [{ instruction_addr: addr(0x4b0), in_app: true }] },
				},
			],
		},
		debug_meta: {
			images: [
				{
					type: 'macho',
					debug_id: DSYM_DEBUG_ID.toUpperCase(),
					code_file: '/private/var/containers/Bundle/Application/X/CrashDemo.app/CrashDemo',
					image_addr: `0x${IMAGE_ADDR.toString(16)}`,
					image_size: 16384,
					arch: 'arm64',
				},
				{
					type: 'macho',
					debug_id: 'dddddddd-0000-1111-2222-333333333333',
					code_file: '/usr/lib/system/libdyld.dylib',
					image_addr: '0x19a000000',
					image_size: 65536,
				},
			],
		},
	};
}

/** Android crash with an R8-obfuscated stack and exception type. */
export function jvmEvent(): Record<string, unknown> {
	return {
		event_id: 'b'.repeat(32),
		platform: 'java',
		exception: {
			values: [
				{
					type: 'b',
					module: 'a',
					value: 'boom',
					stacktrace: {
						frames: [
							{ function: 'run', module: 'android.os.Handler', lineno: 5, in_app: false },
							{
								function: 'a',
								module: 'a.a',
								lineno: 1,
								filename: 'SourceFile',
								abs_path: 'SourceFile',
								in_app: true,
							},
							{
								function: 'b',
								module: 'a.a',
								lineno: 2,
								filename: 'SourceFile',
								abs_path: 'SourceFile',
								in_app: true,
							},
						],
					},
				},
			],
		},
		debug_meta: { images: [{ type: 'proguard', uuid: MAPPING_UUID }] },
	};
}
