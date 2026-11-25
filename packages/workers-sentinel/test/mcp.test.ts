import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	getAdminPasskeySession,
} from './utils';

const BASE = 'http://localhost';

let nextId = 1;

async function rpc(
	token: string | null,
	method: string,
	params?: unknown,
	headers: Record<string, string> = {},
) {
	const response = await SELF.fetch(`${BASE}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
	});
	return response;
}

async function rpcResult<T = Record<string, unknown>>(
	token: string,
	method: string,
	params?: unknown,
): Promise<T> {
	const response = await rpc(token, method, params);
	expect(response.status, await response.clone().text()).toBe(200);
	const body = (await response.json()) as { result?: T; error?: { message: string } };
	expect(body.error, JSON.stringify(body.error)).toBeUndefined();
	return body.result as T;
}

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
	const result = await rpcResult<CallResult>(token, 'tools/call', { name, arguments: args });
	const text = result.content.map((c) => c.text).join('\n');
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { isError: result.isError === true, text, json: json as Record<string, any> };
}

async function toolNames(token: string): Promise<string[]> {
	const { tools } = await rpcResult<{ tools: Array<{ name: string }> }>(token, 'tools/list');
	return tools.map((t) => t.name).sort();
}

async function mintToken(session: string, scopes?: string[]) {
	const response = await authFetch(session, `${BASE}/api/auth/tokens`, {
		method: 'POST',
		body: JSON.stringify({
			name: `mcp ${crypto.randomUUID().slice(0, 6)}`,
			...(scopes ? { scopes } : {}),
		}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { rawToken: string; token: { id: string } };
}

const READ_TOOLS = [
	'check_debug_files',
	'get_event',
	'get_issue',
	'get_project',
	'get_setup_guide',
	'list_debug_files',
	'list_issues',
	'list_platforms',
	'list_projects',
	'list_releases',
	'whoami',
];
const WRITE_TOOLS = [
	'add_issue_note',
	'delete_debug_file',
	'get_debug_file_upload',
	'send_test_event',
	'test_webhook',
	'update_issue',
	'update_project',
	'upload_debug_file',
];
const PROJECT_TOOLS = ['create_project', 'delete_project', 'rotate_dsn'];

describe('MCP endpoint (/mcp)', () => {
	let adminSession: string;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let project: Awaited<ReturnType<typeof createTestProject>>;
	let readToken: string;
	let memberWriteToken: string;
	let ownerWriteToken: string;
	let projectsToken: { rawToken: string; token: { id: string } };

	beforeAll(async () => {
		adminSession = (await getAdminPasskeySession()).token;
		owner = await createTestUser({
			email: `mcp-owner-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'MCP Owner',
		});
		member = await createTestUser({
			email: `mcp-member-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'MCP Member',
		});
		project = await createTestProject(owner.token!, {
			name: `MCP ${Date.now()}`,
			platform: 'node',
		});
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.ok).toBe(true);
		readToken = (await mintToken(owner.token!, ['read'])).rawToken;
		ownerWriteToken = (await mintToken(owner.token!)).rawToken;
		memberWriteToken = (await mintToken(member.token!)).rawToken;
		projectsToken = await mintToken(adminSession, ['projects']);
	});

	afterAll(async () => {
		await authFetch(adminSession, `${BASE}/api/auth/tokens/${projectsToken.token.id}`, {
			method: 'DELETE',
		});
	});

	describe('protocol', () => {
		it('requires a credential', async () => {
			expect((await rpc(null, 'initialize')).status).toBe(401);
			expect((await rpc('wst_nope', 'initialize')).status).toBe(401);
		});

		it('initializes, negotiating the protocol version', async () => {
			const result = await rpcResult<{
				protocolVersion: string;
				serverInfo: { name: string };
				capabilities: Record<string, unknown>;
				instructions: string;
			}>(readToken, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
			});
			expect(result.protocolVersion).toBe('2025-06-18');
			expect(result.serverInfo.name).toBe('sentinel');
			expect(result.capabilities).toHaveProperty('tools');
			expect(result.instructions).toContain('whoami');

			const unknown = await rpcResult<{ protocolVersion: string }>(readToken, 'initialize', {
				protocolVersion: '1999-01-01',
			});
			expect(unknown.protocolVersion).toBe('2025-11-25');
		});

		it('answers notifications with 202 and no body, and pings', async () => {
			const response = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readToken}` },
				body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			});
			expect(response.status).toBe(202);
			expect(await response.text()).toBe('');
			expect(await rpcResult(readToken, 'ping')).toEqual({});
		});

		it('handles batches, unknown methods and bad JSON', async () => {
			const batch = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readToken}` },
				body: JSON.stringify([
					{ jsonrpc: '2.0', id: 1, method: 'ping' },
					{ jsonrpc: '2.0', method: 'notifications/initialized' },
					{ jsonrpc: '2.0', id: 2, method: 'nope' },
				]),
			});
			const answers = (await batch.json()) as Array<{
				id: number;
				result?: unknown;
				error?: { code: number };
			}>;
			expect(answers).toHaveLength(2);
			expect(answers[0]).toMatchObject({ id: 1, result: {} });
			expect(answers[1].error?.code).toBe(-32601);

			const bad = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readToken}` },
				body: '{not json',
			});
			expect(bad.status).toBe(400);
			expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
		});

		it('only speaks POST', async () => {
			const get = await SELF.fetch(`${BASE}/mcp`, {
				headers: { Authorization: `Bearer ${readToken}` },
			});
			expect(get.status).toBe(405);
			expect(get.headers.get('Allow')).toBe('POST');
		});

		it('lists prompts and renders connect_project', async () => {
			const { prompts } = await rpcResult<{ prompts: Array<{ name: string }> }>(
				readToken,
				'prompts/list',
			);
			expect(prompts.map((p) => p.name)).toEqual([
				'connect_project',
				'triage_issues',
				'upload_debug_files',
			]);
			const rendered = await rpcResult<{ messages: Array<{ content: { text: string } }> }>(
				readToken,
				'prompts/get',
				{
					name: 'connect_project',
					arguments: { platform: 'cloudflare-workers' },
				},
			);
			expect(rendered.messages[0].content.text).toContain('get_setup_guide');
			expect(rendered.messages[0].content.text).toContain('cloudflare-workers');
		});
	});

	describe('tools follow the token scopes', () => {
		it('a read token sees only read tools', async () => {
			expect(await toolNames(readToken)).toEqual(READ_TOOLS);
		});

		it('a write token adds the write tools', async () => {
			expect(await toolNames(ownerWriteToken)).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
		});

		it('an admin projects token sees everything', async () => {
			expect(await toolNames(projectsToken.rawToken)).toEqual(
				[...READ_TOOLS, ...WRITE_TOOLS, ...PROJECT_TOOLS].sort(),
			);
		});

		it('calling a hidden tool is a clear tool error, and nothing changes', async () => {
			const result = await call(readToken, 'update_project', {
				project: project.slug,
				name: 'nope',
			});
			expect(result.isError).toBe(true);
			expect(result.text).toContain('"write" scope');
		});

		it('declares read-only and destructive hints', async () => {
			const { tools } = await rpcResult<{
				tools: Array<{
					name: string;
					annotations: { readOnlyHint: boolean; destructiveHint: boolean };
				}>;
			}>(projectsToken.rawToken, 'tools/list');
			const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
			expect(byName.get_issue.readOnlyHint).toBe(true);
			expect(byName.update_issue.readOnlyHint).toBe(false);
			expect(byName.delete_project.destructiveHint).toBe(true);
			expect(byName.rotate_dsn.destructiveHint).toBe(true);
		});

		it('validates arguments', async () => {
			const result = await call(readToken, 'get_project', {});
			expect(result.isError).toBe(true);
			expect(result.text).toContain('"project" is required');
			const extra = await call(readToken, 'get_project', { project: project.slug, bogus: 1 });
			expect(extra.text).toContain('unknown argument');
		});
	});

	describe('tools follow the project roles', () => {
		it('whoami tells the agent who it is and what it may do', async () => {
			const me = await call(memberWriteToken, 'whoami');
			expect(me.json.user.email).toBe(member.email);
			expect(me.json.credential).toMatchObject({
				type: 'api_token',
				scopes: ['read', 'write'],
				neverExpires: true,
			});
			expect(me.json.canCreateProjects).toBe(false);
			const entry = me.json.projects.find((p: { slug: string }) => p.slug === project.slug);
			expect(entry.role).toBe('member');
			expect(entry.can).toMatchObject({
				triageIssues: true,
				editSettings: false,
				deleteIssues: false,
				deleteProject: false,
			});
		});

		it('a member cannot change settings through the MCP', async () => {
			const result = await call(memberWriteToken, 'update_project', {
				project: project.slug,
				retention_days: 7,
			});
			expect(result.isError).toBe(true);
			expect(result.text).toContain('Permission denied');
		});

		it('the owner can; get_project shows the settings to them', async () => {
			const result = await call(ownerWriteToken, 'update_project', {
				project: project.slug,
				name: 'Renamed by MCP',
			});
			expect(result.isError).toBe(false);
			const detail = await call(ownerWriteToken, 'get_project', { project: project.slug });
			expect(detail.json.name).toBe('Renamed by MCP');
			expect(detail.json.can.editSettings).toBe(true);
			expect(detail.json.dsn).toMatch(/^https:\/\/[0-9a-f]+@localhost\/\d+$/);
		});

		it('a project the user is not in reads as not found', async () => {
			const stranger = await createTestUser({
				email: `mcp-stranger-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Stranger',
			});
			const token = (await mintToken(stranger.token!, ['read'])).rawToken;
			const result = await call(token, 'get_project', { project: project.slug });
			expect(result.isError).toBe(true);
			expect(result.text).toContain('Not found');
		});
	});

	describe('connecting an app end to end with a projects token', () => {
		it('creates the project, serves its guide, verifies with a test event, triages, rotates and deletes', async () => {
			const token = projectsToken.rawToken;

			const platforms = await call(token, 'list_platforms');
			expect(platforms.json.platforms.map((p: { id: string }) => p.id)).toContain(
				'cloudflare-workers',
			);

			const created = await call(token, 'create_project', {
				name: 'MCP Workers App',
				platform: 'cloudflare-workers',
			});
			expect(created.isError, created.text).toBe(false);
			const slug = /slug: ([a-z0-9-]+)/.exec(created.text)?.[1];
			expect(slug).toBeTruthy();
			expect(created.text).toContain('@sentry/cloudflare');
			expect(created.text).toMatch(/DSN: https:\/\/[0-9a-f]+@localhost\/\d+/);

			const guide = await call(token, 'get_setup_guide', { project: slug, platform: 'envelope' });
			expect(guide.text).toContain('reportError');

			const sent = await call(token, 'send_test_event', {
				project: slug,
				message: 'Hello from the MCP',
			});
			expect(sent.json).toMatchObject({ sent: true, stored: true });

			const issues = await call(token, 'list_issues', { project: slug });
			const issue = issues.json.issues.find((i: { title: string }) =>
				i.title.includes('Hello from the MCP'),
			);
			expect(issue).toBeDefined();

			const detail = await call(token, 'get_issue', { project: slug, issue_id: issue.id });
			expect(detail.json.latestEvent.tags).toMatchObject({ sentinel_test: 'true' });

			expect(
				(
					await call(token, 'add_issue_note', {
						project: slug,
						issue_id: issue.id,
						text: 'Checked by MCP',
					})
				).isError,
			).toBe(false);
			expect(
				(
					await call(token, 'update_issue', {
						project: slug,
						issue_id: issue.id,
						status: 'resolved',
					})
				).isError,
			).toBe(false);
			const resolved = await call(token, 'list_issues', { project: slug, status: 'resolved' });
			expect(resolved.json.issues.some((i: { id: string }) => i.id === issue.id)).toBe(true);

			// destructive tools need the slug repeated
			const noConfirm = await call(token, 'rotate_dsn', { project: slug, confirm: 'wrong' });
			expect(noConfirm.isError).toBe(true);
			const before = (await call(token, 'get_project', { project: slug })).json.dsn;
			const rotated = await call(token, 'rotate_dsn', { project: slug, confirm: slug });
			expect(rotated.json.rotated).toBe(true);
			expect(rotated.json.dsn).not.toBe(before);
			// the new DSN works end to end
			expect((await call(token, 'send_test_event', { project: slug })).json.stored).toBe(true);

			const notDeleted = await call(token, 'delete_project', { project: slug, confirm: 'nope' });
			expect(notDeleted.isError).toBe(true);
			const deleted = await call(token, 'delete_project', { project: slug, confirm: slug });
			expect(deleted.json.deleted).toBe(true);
			expect((await call(token, 'get_project', { project: slug })).isError).toBe(true);
		});

		it('a non-admin never sees create_project, even with every scope it can get', async () => {
			expect(await toolNames(ownerWriteToken)).not.toContain('create_project');
		});
	});
});
