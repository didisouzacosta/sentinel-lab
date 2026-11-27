import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { chunkKey, debugFileKey } from '../src/lib/debug-files';
import { machOKind, parseMachO } from '../src/lib/macho';
import { handleQueue } from '../src/queue';
import type { ProcessJob } from '../src/types';
import thinB64 from './fixtures/dif/crashdemo-arm64.dsym.b64?raw';
import executableB64 from './fixtures/dif/crashdemo-arm64-executable.b64?raw';
import universalB64 from './fixtures/dif/crashdemo-universal.dsym.b64?raw';
import mapping from './fixtures/dif/mapping.txt?raw';
import { adminFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

// Fixtures: test/fixtures/dif/crash.c built for arm64 + x86_64 (clang -g,
// lipo, dsymutil). UUIDs as printed by `dwarfdump --uuid`.
const ARM64_UUID = '50b959c2-7066-33ae-8751-88bd95371d96';
const X86_UUID = '3ce4686a-4de6-3709-a22d-8a6328321638';
// What `sentry-cli upload-proguard mapping.txt` (3.8.2) derives without --uuid.
const MAPPING_UUID = '76030f1c-2e68-573e-87fc-2b96898fdff3';

const BASE = 'http://localhost';

function bytesOf(b64: string): Uint8Array {
	const binary = atob(b64.replace(/\s+/g, ''));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(
			new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);
}

interface DebugFile {
	id: string;
	debugId: string;
	kind: string;
	arch: string | null;
	name: string;
	size: number;
	sha1: string | null;
}

describe('Debug files', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: Awaited<ReturnType<typeof createTestProject>>;

	const thin = bytesOf(thinB64);
	const universal = bytesOf(universalB64);
	const executable = bytesOf(executableB64);

	const upload = (
		token: string,
		body: BodyInit,
		query = '',
		headers: Record<string, string> = {},
	) =>
		SELF.fetch(`${BASE}/api/projects/${project.slug}/debug-files${query}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, ...headers },
			body,
		});

	const api = (token: string, path: string, init: RequestInit = {}) =>
		SELF.fetch(`${BASE}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				...(init.headers ?? {}),
			},
		});

	beforeAll(async () => {
		owner = await createTestUser({
			email: `dif-owner-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'DIF Owner',
		});
		member = await createTestUser({
			email: `dif-member-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'DIF Member',
		});
		project = await createTestProject(owner.token!, {
			name: 'Debug Files Project',
			platform: 'cocoa',
		});
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	describe('Mach-O reader', () => {
		it('reads the UUID, arch and DWARF segment of a thin dSYM', () => {
			expect(machOKind(thin).kind).toBe('thin');
			const object = parseMachO(thin);
			expect(object).toMatchObject({ uuid: ARM64_UUID, arch: 'arm64', hasDwarf: true });
		});

		it('lists the slices of a universal dSYM', () => {
			const shape = machOKind(universal);
			expect(shape.kind).toBe('fat');
			expect(shape.kind === 'fat' && shape.slices).toHaveLength(2);
		});

		it('tells an executable without DWARF apart', () => {
			const object = parseMachO(executable);
			expect(object?.hasDwarf).toBe(false);
			expect(object?.fileType).not.toBe(0xa);
		});
	});

	describe('direct upload', () => {
		it('stores a thin dSYM under its UUID', async () => {
			const response = await upload(member.token!, thin, '?name=CrashDemo');
			expect(response.status).toBe(201);
			const { debugFiles } = (await response.json()) as { debugFiles: DebugFile[] };
			expect(debugFiles).toHaveLength(1);
			expect(debugFiles[0]).toMatchObject({
				debugId: ARM64_UUID,
				kind: 'macho',
				arch: 'arm64',
				name: 'CrashDemo',
				size: thin.length,
				sha1: await sha1Hex(thin),
			});
			const stored = await env.DEBUG_FILES!.get(debugFileKey(project.id, ARM64_UUID, 'macho'));
			expect(stored?.size).toBe(thin.length);
		});

		it('splits a universal dSYM into one file per architecture', async () => {
			const response = await upload(owner.token!, universal, '?name=CrashDemo.dSYM');
			expect(response.status).toBe(201);
			const { debugFiles } = (await response.json()) as { debugFiles: DebugFile[] };
			expect(debugFiles.map((f) => f.debugId).sort()).toEqual([X86_UUID, ARM64_UUID].sort());
			const x86 = await env.DEBUG_FILES!.get(debugFileKey(project.id, X86_UUID, 'macho'));
			const bytes = new Uint8Array(await x86!.arrayBuffer());
			expect(parseMachO(bytes)?.uuid).toBe(X86_UUID);
			const leftovers = await env.DEBUG_FILES!.list({ prefix: `staging/${project.id}/` });
			expect(leftovers.objects).toHaveLength(0);
		});

		it('refuses the app binary with a useful message', async () => {
			const response = await upload(owner.token!, executable);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; message: string };
			expect(body.error).toBe('not_debug_file');
			expect(body.message).toContain('.dSYM');
		});

		it('refuses unknown formats', async () => {
			const response = await upload(owner.token!, 'just some text\n');
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe('unsupported_file');
		});

		it('stores a ProGuard mapping under the given UUID', async () => {
			const uuid = '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';
			const response = await upload(owner.token!, mapping, `?kind=proguard&debugId=${uuid}`);
			expect(response.status).toBe(201);
			const { debugFiles } = (await response.json()) as { debugFiles: DebugFile[] };
			expect(debugFiles[0]).toMatchObject({ debugId: uuid, kind: 'proguard', name: 'mapping.txt' });
		});

		it('derives the same ProGuard UUID as sentry-cli when none is given', async () => {
			const response = await upload(
				owner.token!,
				mapping,
				'?kind=proguard&name=mapping-derived.txt',
			);
			expect(response.status).toBe(201);
			const { debugFiles } = (await response.json()) as { debugFiles: DebugFile[] };
			expect(debugFiles[0].debugId).toBe(MAPPING_UUID);
		});

		it('accepts a gzip body', async () => {
			const response = await upload(owner.token!, await gzip(thin), '?name=gz', {
				'Content-Encoding': 'gzip',
			});
			expect(response.status).toBe(201);
		});

		it('requires authentication and the write scope', async () => {
			const anonymous = await SELF.fetch(`${BASE}/api/projects/${project.slug}/debug-files`, {
				method: 'POST',
				body: thin,
			});
			expect(anonymous.status).toBe(401);
			const tokenResponse = await api(owner.token!, '/api/auth/tokens', {
				method: 'POST',
				body: JSON.stringify({ name: 'read-only', scopes: ['read'] }),
			});
			const { rawToken } = (await tokenResponse.json()) as { rawToken: string };
			const denied = await upload(rawToken, thin);
			expect(denied.status).toBe(403);
		});
	});

	describe('list, check and delete', () => {
		it('lists stored files', async () => {
			const response = await api(
				member.token!,
				`/api/projects/${project.slug}/debug-files?kind=macho`,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { debugFiles: DebugFile[]; usage: { bytes: number } };
			expect(body.debugFiles.map((f) => f.debugId)).toEqual(
				expect.arrayContaining([ARM64_UUID, X86_UUID]),
			);
			expect(body.usage.bytes).toBeGreaterThan(0);
		});

		it('checks debug ids', async () => {
			const missing = '11111111-2222-3333-4444-555555555555';
			const response = await api(member.token!, `/api/projects/${project.slug}/debug-files/check`, {
				method: 'POST',
				body: JSON.stringify({ debugIds: [ARM64_UUID.toUpperCase(), missing] }),
			});
			const body = (await response.json()) as {
				images: Array<{ debugId: string; status: string }>;
				found: number;
				missing: number;
			};
			expect(body.found).toBe(1);
			expect(body.missing).toBe(1);
			expect(body.images.find((i) => i.debugId === missing)?.status).toBe('missing');
		});

		it("checks an event's debug_meta images", async () => {
			const { id } = await sendTestEvent(project.id, project.publicKey, {
				platform: 'cocoa',
				level: 'fatal',
				exception: { values: [{ type: 'EXC_BAD_ACCESS', value: 'crash' }] },
				debug_meta: {
					images: [
						{
							type: 'macho',
							debug_id: ARM64_UUID,
							code_file: '/App/CrashDemo',
							image_addr: '0x100000000',
						},
						{
							type: 'macho',
							debug_id: '99999999-8888-7777-6666-555555555555',
							code_file: '/usr/lib/libSystem',
						},
					],
				},
			} as never);
			const response = await api(member.token!, `/api/projects/${project.slug}/debug-files/check`, {
				method: 'POST',
				body: JSON.stringify({ eventId: id }),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				images: Array<{ debugId: string; status: string; codeFile: string }>;
			};
			expect(body.images).toHaveLength(2);
			expect(body.images.find((i) => i.debugId === ARM64_UUID)).toMatchObject({
				status: 'found',
				codeFile: '/App/CrashDemo',
			});
		});

		it('lets only owners and admins delete', async () => {
			const list = await api(
				owner.token!,
				`/api/projects/${project.slug}/debug-files?debugId=${X86_UUID}`,
			);
			const [file] = ((await list.json()) as { debugFiles: DebugFile[] }).debugFiles;
			const denied = await api(
				member.token!,
				`/api/projects/${project.slug}/debug-files/${file.id}`,
				{
					method: 'DELETE',
				},
			);
			expect(denied.status).toBe(403);
			const deleted = await api(
				owner.token!,
				`/api/projects/${project.slug}/debug-files/${file.id}`,
				{
					method: 'DELETE',
				},
			);
			expect(deleted.status).toBe(200);
			expect(await env.DEBUG_FILES!.head(debugFileKey(project.id, X86_UUID, 'macho'))).toBeNull();
		});

		it('is reachable for CI under /api/0 too', async () => {
			const response = await api(
				owner.token!,
				`/api/0/projects/sentinel/${project.slug}/debug-files/`,
			);
			expect(response.status).toBe(200);
			const notMember = await createTestUser({
				email: `dif-stranger-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Stranger',
			});
			const hidden = await api(
				notMember.token!,
				`/api/0/projects/sentinel/${project.slug}/debug-files/`,
			);
			expect(hidden.status).toBe(404);
			expect(await hidden.json()).toHaveProperty('detail');
		});
	});

	describe('sentry-cli protocol', () => {
		it('advertises chunk upload options', async () => {
			const response = await api(owner.token!, '/api/0/organizations/sentinel/chunk-upload/');
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				url: string;
				accept: string[];
				hashAlgorithm: string;
			};
			expect(body.url).toBe('organizations/sentinel/chunk-upload/');
			expect(body.accept).toEqual(['debug_files', 'proguard']);
			expect(body.hashAlgorithm).toBe('sha1');
		});

		async function assemble(
			files: Record<string, { name: string; debug_id?: string; chunks: string[] }>,
		) {
			const response = await api(
				owner.token!,
				`/api/0/projects/sentinel/${project.slug}/files/difs/assemble/`,
				{
					method: 'POST',
					body: JSON.stringify(files),
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()) as Record<
				string,
				{
					state: string;
					missingChunks: string[];
					detail?: string;
					dif?: { debugId: string; symbolType: string };
				}
			>;
		}

		async function uploadChunks(chunks: Uint8Array[]) {
			const form = new FormData();
			for (const chunk of chunks) {
				form.append('file_gzip', new File([await gzip(chunk)], await sha1Hex(chunk)));
			}
			return SELF.fetch(`${BASE}/api/0/organizations/sentinel/chunk-upload/`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${owner.token}` },
				body: form,
			});
		}

		it('assembles a dSYM object from chunks', async () => {
			// Split into two chunks to exercise concatenation.
			const parts = [thin.subarray(0, 4096), thin.subarray(4096)];
			const checksum = await sha1Hex(thin);
			const chunkIds = await Promise.all(parts.map((part) => sha1Hex(part)));
			const files = { [checksum]: { name: 'CrashDemo', debug_id: ARM64_UUID, chunks: chunkIds } };

			const first = await assemble(files);
			// Already stored by the direct upload above: sentry-cli is told it is done.
			expect(first[checksum].state).toBe('ok');

			const fresh = new Uint8Array(thin);
			fresh[fresh.length - 1] ^= 0xff; // different content, same UUID
			const freshChecksum = await sha1Hex(fresh);
			const freshParts = [fresh.subarray(0, 4096), fresh.subarray(4096)];
			const freshIds = await Promise.all(freshParts.map((part) => sha1Hex(part)));
			const freshFiles = {
				[freshChecksum]: { name: 'CrashDemo', debug_id: ARM64_UUID, chunks: freshIds },
			};
			const missing = await assemble(freshFiles);
			expect(missing[freshChecksum].state).toBe('not_found');
			expect(missing[freshChecksum].missingChunks.sort()).toEqual([...freshIds].sort());

			expect((await uploadChunks(freshParts)).status).toBe(200);
			const done = await assemble(freshFiles);
			expect(done[freshChecksum]).toMatchObject({
				state: 'ok',
				dif: { debugId: ARM64_UUID, symbolType: 'macho' },
			});
		});

		it('assembles large uploads on the queue', async () => {
			const fresh = new Uint8Array(thin);
			fresh[fresh.length - 2] ^= 0xff;
			const checksum = await sha1Hex(fresh);
			await env.DEBUG_FILES!.put(chunkKey(checksum), fresh);
			const job: ProcessJob = {
				type: 'dif.assemble',
				projectId: project.id,
				checksum,
				name: 'CrashDemo',
				debugId: ARM64_UUID,
				chunks: [checksum],
			};
			const outcome = { acked: false, retried: false };
			await handleQueue(
				{
					queue: 'sentinel-lab-process',
					messages: [
						{
							id: '1',
							timestamp: new Date(),
							attempts: 1,
							body: job,
							ack: () => {
								outcome.acked = true;
							},
							retry: () => {
								outcome.retried = true;
							},
						},
					],
					ackAll: () => {},
					retryAll: () => {},
				} as unknown as MessageBatch<ProcessJob>,
				env as never,
			);
			expect(outcome).toEqual({ acked: true, retried: false });
			const done = await assemble({ [checksum]: { name: 'CrashDemo', chunks: [checksum] } });
			expect(done[checksum]).toMatchObject({ state: 'ok', dif: { debugId: ARM64_UUID } });
		});

		it('acknowledges the app binary next to the dSYM without storing it', async () => {
			// Xcode's products folder holds MyApp.app and MyApp.app.dSYM; sentry-cli sends both.
			const checksum = await sha1Hex(executable);
			expect((await uploadChunks([executable])).status).toBe(200);
			const result = await assemble({
				[checksum]: { name: 'CrashDemo', debug_id: ARM64_UUID, chunks: [checksum] },
			});
			expect(result[checksum]).toMatchObject({
				state: 'ok',
				dif: { debugId: ARM64_UUID, data: { type: 'exe' } },
			});
			const stored = await env.DEBUG_FILES!.get(debugFileKey(project.id, ARM64_UUID, 'macho'));
			expect(parseMachO(new Uint8Array(await stored!.arrayBuffer()))?.hasDwarf).toBe(true);
		});

		it('assembles a ProGuard mapping named like sentry-cli upload-proguard', async () => {
			const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
			const bytes = new TextEncoder().encode(mapping.replace('bar', 'baz'));
			const checksum = await sha1Hex(bytes);
			expect((await uploadChunks([bytes])).status).toBe(200);
			const result = await assemble({
				[checksum]: { name: `/proguard/${uuid}.txt`, chunks: [checksum] },
			});
			expect(result[checksum]).toMatchObject({
				state: 'ok',
				dif: { debugId: uuid, symbolType: 'proguard' },
			});
		});

		it('stores the same mapping again under a new UUID', async () => {
			const bytes = new TextEncoder().encode(mapping.replace('bar', 'baz'));
			const checksum = await sha1Hex(bytes);
			const other = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
			const result = await assemble({
				[checksum]: { name: `/proguard/${other}.txt`, chunks: [checksum] },
			});
			expect(result[checksum]).toMatchObject({ state: 'ok', dif: { debugId: other } });
		});

		it('rejects a chunk whose name is not its SHA-1', async () => {
			const form = new FormData();
			form.append('file', new File([new Uint8Array([1, 2, 3])], 'a'.repeat(40)));
			const response = await SELF.fetch(`${BASE}/api/0/organizations/sentinel/chunk-upload/`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${owner.token}` },
				body: form,
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { detail: string }).detail).toContain('SHA-1');
		});

		it('lists files in the Sentry shape', async () => {
			const response = await api(
				owner.token!,
				`/api/0/projects/sentinel/${project.slug}/files/dsyms/`,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as Array<{ debugId: string; symbolType: string }>;
			expect(body.some((f) => f.debugId === ARM64_UUID && f.symbolType === 'macho')).toBe(true);
		});

		it('answers the API root sentry-cli info reads', async () => {
			const response = await api(owner.token!, '/api/0/');
			expect(response.status).toBe(200);
			expect(((await response.json()) as { user: { email: string } }).user.email).toBe(owner.email);
		});
	});

	describe('MCP tools', () => {
		async function callTool(name: string, args: Record<string, unknown>) {
			const response = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${owner.token}`,
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name, arguments: args },
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				result: { isError?: boolean; content: Array<{ text: string }> };
			};
			const text = body.result.content[0].text;
			return {
				isError: body.result.isError === true,
				text,
				json: JSON.parse(text.startsWith('{') ? text : '{}'),
			};
		}

		it('uploads a small file and checks it', async () => {
			const uuid = 'c1c2c3c4-d5d6-4e7f-8a9b-0c1d2e3f4a5b';
			const upload = await callTool('upload_debug_file', {
				project: project.slug,
				contentBase64: btoa(mapping),
				kind: 'proguard',
				debugId: uuid,
			});
			expect(upload.isError).toBe(false);
			expect(upload.json.debugFiles[0].debugId).toBe(uuid);
			const check = await callTool('check_debug_files', {
				project: project.slug,
				debugIds: [uuid],
			});
			expect(check.json.found).toBe(1);
			const listed = await callTool('list_debug_files', {
				project: project.slug,
				kind: 'proguard',
			});
			expect(listed.json.debugFiles.some((f: DebugFile) => f.debugId === uuid)).toBe(true);
		});

		it('gives upload instructions with the project filled in and no token', async () => {
			const guide = await callTool('get_debug_file_upload', { project: project.slug });
			expect(guide.isError).toBe(false);
			expect(guide.json.sentryCli.env).toMatchObject({
				SENTRY_URL: 'http://localhost',
				SENTRY_PROJECT: project.slug,
				SENTRY_AUTH_TOKEN: '$SENTINEL_AUTH_TOKEN',
			});
			expect(guide.json.xcodeCloud.environment).toMatchObject({
				SENTINEL_URL: 'http://localhost',
				SENTINEL_PROJECT: project.slug,
			});
			expect(guide.json.xcodeCloud.ciPostXcodebuild).toContain('$CI_ARCHIVE_PATH/dSYMs');
			expect(guide.json.archivePostAction).toContain('$ARCHIVE_DSYMS_PATH');
			expect(guide.text).not.toContain(owner.token!);
		});

		it('requires confirm to delete', async () => {
			const result = await callTool('delete_debug_file', {
				project: project.slug,
				id: 'x',
				confirm: 'y',
			});
			expect(result.isError).toBe(true);
		});
	});
});
