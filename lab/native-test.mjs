// Envia envelopes no formato que sentry-cocoa (iOS) e sentry-android geram em
// builds de release: frames sem nome (só endereços + debug_meta com UUID do dSYM)
// e classes ofuscadas pelo R8 (com o UUID do mapping ProGuard).
const BASE = process.env.SENTINEL_BASE ?? 'http://127.0.0.1:8787';
const PROJECT = process.env.SENTINEL_PROJECT;
const KEY = process.env.SENTINEL_KEY;

function envelope(event) {
	const event_id = crypto.randomUUID().replace(/-/g, '');
	return [
		JSON.stringify({ event_id, sent_at: new Date().toISOString() }),
		JSON.stringify({ type: 'event' }),
		JSON.stringify({ event_id, timestamp: new Date().toISOString(), ...event }),
	].join('\n');
}

// iOS: crash EXC_BAD_ACCESS num build de release, só com endereços.
// imageAddr diferente simula ASLR (cada execução carrega o binário noutro endereço).
function iosCrash(imageAddr) {
	const base = BigInt(imageAddr);
	const hex = (n) => `0x${n.toString(16).padStart(16, '0')}`;
	return {
		platform: 'cocoa',
		level: 'fatal',
		release: 'com.exemplo.loja@3.2.0+412',
		environment: 'production',
		contexts: { os: { name: 'iOS', version: '18.1' }, device: { model: 'iPhone16,2' } },
		exception: {
			values: [
				{
					type: 'EXC_BAD_ACCESS',
					value: 'KERN_INVALID_ADDRESS at 0x0000000000000010',
					mechanism: { type: 'mach', handled: false },
					stacktrace: {
						frames: [
							{
								instruction_addr: '0x00000001a2b3c4d8',
								package: '/usr/lib/system/libdyld.dylib',
								in_app: false,
							},
							{
								instruction_addr: hex(base + 0x1a2f0n),
								package: '/private/var/containers/Bundle/Application/X/Loja.app/Loja',
								image_addr: hex(base),
								in_app: true,
							},
							{
								instruction_addr: hex(base + 0x4b81cn),
								package: '/private/var/containers/Bundle/Application/X/Loja.app/Loja',
								image_addr: hex(base),
								in_app: true,
							},
							{
								instruction_addr: hex(base + 0x4c004n),
								package: '/private/var/containers/Bundle/Application/X/Loja.app/Loja',
								image_addr: hex(base),
								in_app: true,
							},
						],
					},
				},
			],
		},
		debug_meta: {
			images: [
				{
					type: 'macho',
					code_file: '/private/var/containers/Bundle/Application/X/Loja.app/Loja',
					debug_id: '8a6c3f2e-1b4d-3c5e-9f7a-0d2e4b6c8a1f',
					image_addr: hex(base),
					image_size: 5242880,
					arch: 'arm64',
				},
			],
		},
	};
}

// Android: NullPointerException com nomes ofuscados pelo R8.
function androidCrash() {
	return {
		platform: 'java',
		level: 'fatal',
		release: 'com.exemplo.loja@3.2.0+412',
		environment: 'production',
		contexts: { os: { name: 'Android', version: '15' } },
		exception: {
			values: [
				{
					type: 'NullPointerException',
					module: 'java.lang',
					value: "Attempt to invoke virtual method 'int a.b.c.d()' on a null object reference",
					stacktrace: {
						frames: [
							{
								module: 'android.app.ActivityThread',
								function: 'main',
								filename: 'ActivityThread.java',
								lineno: 8177,
								in_app: false,
							},
							{
								module: 'a.b.e',
								function: 'onClick',
								filename: 'SourceFile',
								lineno: 1,
								in_app: true,
							},
							{ module: 'a.b.c', function: 'a', filename: 'SourceFile', lineno: 4, in_app: true },
						],
					},
				},
			],
		},
		debug_meta: { images: [{ type: 'proguard', uuid: '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c' }] },
	};
}

async function send(event, label) {
	const r = await fetch(`${BASE}/api/${PROJECT}/envelope/?sentry_key=${KEY}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-sentry-envelope' },
		body: envelope(event),
	});
	console.log(label, r.status, await r.text());
}

// Mesmo crash iOS em 2 aparelhos (ASLR diferente) e o mesmo crash Android 2x.
await send(iosCrash('0x0000000104000000'), 'ios #1');
await send(iosCrash('0x0000000102c48000'), 'ios #2');
await send(androidCrash(), 'android #1');
await send(androidCrash(), 'android #2');
