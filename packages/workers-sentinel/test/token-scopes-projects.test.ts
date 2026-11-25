import { SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeScopes, parseStoredScopes } from '../src/lib/token-scopes';
import {
	adminFetch,
	authFetch,
	createTestEnvelope,
	createTestProject,
	createTestUser,
	getAdminPasskeySession,
	getAdminPasswordSession,
} from './utils';

const BASE = 'http://localhost';

type Minted = { rawToken: string; token: { id: string; scopes: string[] } };

async function mint(sessionToken: string, body: Record<string, unknown>): Promise<Response> {
	return authFetch(sessionToken, `${BASE}/api/auth/tokens`, {
		method: 'POST',
		body: JSON.stringify({ name: `scoped ${crypto.randomUUID().slice(0, 8)}`, ...body }),
	});
}

async function mintOk(sessionToken: string, scopes?: string[]): Promise<Minted> {
	const response = await mint(sessionToken, scopes ? { scopes } : {});
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as Minted;
}

function ingest(projectId: string, publicKey: string) {
	return SELF.fetch(`${BASE}/api/${projectId}/envelope/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
		},
		body: createTestEnvelope(projectId, publicKey, { message: 'scope probe' }),
	});
}

async function auditFor(projectId: string, action: string) {
	const response = await adminFetch(`${BASE}/api/admin/audit?limit=100`);
	const { entries } = (await response.json()) as {
		entries: Array<{
			action: string;
			targetId: string | null;
			details: Record<string, unknown> | null;
		}>;
	};
	return entries.find((e) => e.action === action && e.targetId === projectId);
}

describe('token scope helpers', () => {
	it('defaults to read + write and closes scopes downward', () => {
		expect(normalizeScopes(undefined)).toEqual({ ok: true, scopes: ['read', 'write'] });
		expect(normalizeScopes(['read'])).toEqual({ ok: true, scopes: ['read'] });
		expect(normalizeScopes(['write'])).toEqual({ ok: true, scopes: ['read', 'write'] });
		expect(normalizeScopes(['projects'])).toEqual({
			ok: true,
			scopes: ['read', 'write', 'projects'],
		});
		expect(normalizeScopes([]).ok).toBe(false);
		expect(normalizeScopes(['admin']).ok).toBe(false);
		expect(normalizeScopes('read').ok).toBe(false);
	});

	it('reads stored lists defensively', () => {
		expect(parseStoredScopes('read,write')).toEqual(['read', 'write']);
		expect(parseStoredScopes('projects')).toEqual(['read', 'write', 'projects']);
		expect(parseStoredScopes('bogus')).toEqual(['read']);
		expect(parseStoredScopes(null)).toEqual(['read', 'write']);
	});
});

describe('API token scopes and project lifecycle', () => {
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let memberProject: Awaited<ReturnType<typeof createTestProject>>;
	let readToken: string;
	let writeToken: string;
	let adminSession: string;
	let projectsToken: Minted;

	beforeAll(async () => {
		// first: the first account ever registered becomes admin, and `member`
		// must stay a plain member even when this file runs alone
		adminSession = (await getAdminPasskeySession()).token;
		member = await createTestUser({
			email: `scopes-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Scopes User',
		});
		memberProject = await createTestProject(member.token!, { name: `Scopes ${Date.now()}` });
		readToken = (await mintOk(member.token!, ['read'])).rawToken;
		writeToken = (await mintOk(member.token!)).rawToken;
		projectsToken = await mintOk(adminSession, ['projects']);
	});

	afterAll(async () => {
		// the admin fixture is shared by the suite and capped at 10 tokens
		await authFetch(adminSession, `${BASE}/api/auth/tokens/${projectsToken.token.id}`, {
			method: 'DELETE',
		});
	});

	describe('minting', () => {
		it('mints read + write by default and lists the scopes', async () => {
			const minted = await mintOk(member.token!);
			expect(minted.token.scopes).toEqual(['read', 'write']);
			const list = await authFetch(member.token!, `${BASE}/api/auth/tokens`);
			const { tokens } = (await list.json()) as { tokens: Array<{ id: string; scopes: string[] }> };
			expect(tokens.find((t) => t.id === minted.token.id)?.scopes).toEqual(['read', 'write']);
		});

		it('rejects unknown scopes', async () => {
			const response = await mint(member.token!, { scopes: ['read', 'admin'] });
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe('invalid_scopes');
		});

		it('only lets an admin in a passkey session mint the projects scope', async () => {
			const asMember = await mint(member.token!, { scopes: ['projects'] });
			expect(asMember.status).toBe(403);
			expect(((await asMember.json()) as { error: string }).error).toBe('forbidden');

			const asPasswordAdmin = await mint(await getAdminPasswordSession(), { scopes: ['projects'] });
			expect(asPasswordAdmin.status).toBe(403);
			expect(((await asPasswordAdmin.json()) as { error: string }).error).toBe('passkey_required');

			expect(projectsToken.token.scopes).toEqual(['read', 'write', 'projects']);
		});
	});

	describe('read and write', () => {
		it('a read token reads but cannot change anything', async () => {
			expect((await authFetch(readToken, `${BASE}/api/projects`)).status).toBe(200);
			expect(
				(await authFetch(readToken, `${BASE}/api/projects/${memberProject.slug}`)).status,
			).toBe(200);

			const patch = await authFetch(readToken, `${BASE}/api/projects/${memberProject.slug}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'nope' }),
			});
			expect(patch.status).toBe(403);
			expect(await patch.json()).toMatchObject({ error: 'insufficient_scope', required: 'write' });

			// /api/0 speaks {detail}
			const triage = await authFetch(
				readToken,
				`${BASE}/api/0/issues/00000000-0000-0000-0000-000000000000/`,
				{
					method: 'PUT',
					body: JSON.stringify({ status: 'resolved' }),
				},
			);
			expect(triage.status).toBe(403);
			expect(((await triage.json()) as { detail: string }).detail).toContain('write');
		});

		it('a write token edits settings but cannot run the project lifecycle', async () => {
			const patch = await authFetch(writeToken, `${BASE}/api/projects/${memberProject.slug}`, {
				method: 'PATCH',
				body: JSON.stringify({ platform: 'cloudflare-workers' }),
			});
			expect(patch.status).toBe(200);

			// (POST /api/projects answers `forbidden` first: a member is not an admin)
			for (const [method, path] of [
				['POST', `/api/projects/${memberProject.slug}/rotate-key`],
				['DELETE', `/api/projects/${memberProject.slug}`],
			] as const) {
				const response = await authFetch(writeToken, `${BASE}${path}`, {
					method,
					body: method === 'POST' ? JSON.stringify({ name: 'x' }) : undefined,
				});
				expect(response.status, `${method} ${path}`).toBe(403);
				expect(await response.json()).toMatchObject({
					error: 'insufficient_scope',
					required: 'projects',
				});
			}
		});
	});

	describe('project lifecycle with a projects token', () => {
		it('creates, edits, rotates the key of and deletes a project, all audited as the token', async () => {
			const raw = projectsToken.rawToken;
			const via = { via: 'api_token', tokenPrefix: raw.slice(0, 12) };

			// create
			const created = await authFetch(raw, `${BASE}/api/projects`, {
				method: 'POST',
				body: JSON.stringify({ name: '  Tem Horário API  ', platform: 'cloudflare-workers' }),
			});
			expect(created.status).toBe(201);
			const { project, dsn } = (await created.json()) as {
				project: { id: string; slug: string; name: string; platform: string; publicKey: string };
				dsn: string;
			};
			expect(project.name).toBe('Tem Horário API');
			expect(project.platform).toBe('cloudflare-workers');
			expect(dsn).toMatch(new RegExp(`^https://${project.publicKey}@localhost/\\d+$`));
			expect(await auditFor(project.id, 'project.created')).toMatchObject({ details: via });
			// the creator owns it
			const detail = await authFetch(raw, `${BASE}/api/projects/${project.slug}`);
			expect(((await detail.json()) as { memberRole: string }).memberRole).toBe('owner');
			expect((await ingest(project.id, project.publicKey)).status).toBe(200);

			// edit
			const edited = await authFetch(raw, `${BASE}/api/projects/${project.slug}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: 'TH API', platform: 'envelope' }),
			});
			expect(edited.status).toBe(200);
			const after = (await (
				await authFetch(raw, `${BASE}/api/projects/${project.slug}`)
			).json()) as {
				project: { name: string; slug: string; platform: string };
			};
			expect(after.project).toMatchObject({
				name: 'TH API',
				slug: project.slug,
				platform: 'envelope',
			});
			expect(await auditFor(project.id, 'project.renamed')).toMatchObject({
				details: { from: 'Tem Horário API', to: 'TH API', ...via },
			});
			expect(await auditFor(project.id, 'project.platform_changed')).toMatchObject({
				details: { from: 'cloudflare-workers', to: 'envelope', ...via },
			});

			// rotate the key: the old one stops at once, the new one works
			const rotated = await authFetch(raw, `${BASE}/api/projects/${project.slug}/rotate-key`, {
				method: 'POST',
			});
			expect(rotated.status).toBe(200);
			const next = (await rotated.json()) as { project: { publicKey: string }; dsn: string };
			expect(next.project.publicKey).not.toBe(project.publicKey);
			expect(next.dsn.split('/').pop()).toBe(dsn.split('/').pop()); // same ingest id
			expect((await ingest(project.id, project.publicKey)).status).toBe(401);
			expect((await ingest(project.id, next.project.publicKey)).status).toBe(200);
			expect(await auditFor(project.id, 'project.key_rotated')).toMatchObject({ details: via });

			// delete
			const deleted = await authFetch(raw, `${BASE}/api/projects/${project.slug}`, {
				method: 'DELETE',
			});
			expect(deleted.status).toBe(200);
			expect((await authFetch(raw, `${BASE}/api/projects/${project.slug}`)).status).toBe(404);
			expect(await auditFor(project.id, 'project.deleted')).toMatchObject({ details: via });
		});

		it('rejects a missing or bad name and platform', async () => {
			const raw = projectsToken.rawToken;
			const noName = await authFetch(raw, `${BASE}/api/projects`, {
				method: 'POST',
				body: JSON.stringify({ name: '   ' }),
			});
			expect(noName.status).toBe(400);
			const badPlatform = await authFetch(raw, `${BASE}/api/projects`, {
				method: 'POST',
				body: JSON.stringify({ name: 'ok', platform: 'x'.repeat(65) }),
			});
			expect(badPlatform.status).toBe(400);
			const badRename = await authFetch(
				member.token!,
				`${BASE}/api/projects/${memberProject.slug}`,
				{
					method: 'PATCH',
					body: JSON.stringify({ name: '' }),
				},
			);
			expect(badRename.status).toBe(400);
			expect(((await badRename.json()) as { error: string }).error).toBe('invalid_name');
		});
	});

	describe('sessions', () => {
		it('creating a project needs an admin passkey session', async () => {
			const asMember = await authFetch(member.token!, `${BASE}/api/projects`, {
				method: 'POST',
				body: JSON.stringify({ name: 'nope' }),
			});
			expect(asMember.status).toBe(403);

			const asPasswordAdmin = await authFetch(
				await getAdminPasswordSession(),
				`${BASE}/api/projects`,
				{
					method: 'POST',
					body: JSON.stringify({ name: 'nope' }),
				},
			);
			expect(asPasswordAdmin.status).toBe(403);
			expect(((await asPasswordAdmin.json()) as { error: string }).error).toBe('passkey_required');

			const asPasskeyAdmin = await authFetch(adminSession, `${BASE}/api/projects`, {
				method: 'POST',
				body: JSON.stringify({ name: `Passkey created ${Date.now()}` }),
			});
			expect(asPasskeyAdmin.status).toBe(201);
			const { project } = (await asPasskeyAdmin.json()) as {
				project: { slug: string; platform: string };
			};
			expect(project.platform).toBe('javascript');
			await authFetch(adminSession, `${BASE}/api/projects/${project.slug}`, { method: 'DELETE' });
		});

		it('the owner may rotate the key; a plain member may not', async () => {
			const other = await createTestUser({
				email: `scopes-member-${Date.now()}@example.com`,
				password: 'testpassword123',
				name: 'Plain Member',
			});
			const add = await adminFetch(`${BASE}/api/admin/projects/${memberProject.id}/members`, {
				method: 'POST',
				body: JSON.stringify({ email: other.email, role: 'member' }),
			});
			expect(add.ok).toBe(true);

			const asMember = await authFetch(
				other.token!,
				`${BASE}/api/projects/${memberProject.slug}/rotate-key`,
				{
					method: 'POST',
				},
			);
			expect(asMember.status).toBe(403);

			const asOwner = await authFetch(
				member.token!,
				`${BASE}/api/projects/${memberProject.slug}/rotate-key`,
				{
					method: 'POST',
				},
			);
			expect(asOwner.status).toBe(200);
		});
	});
});
