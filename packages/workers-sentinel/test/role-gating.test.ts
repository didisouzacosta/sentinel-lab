import { beforeEach, describe, expect, it } from 'vitest';
import {
	adminFetch,
	authFetch,
	createTestProject,
	createTestUser,
	sendTestEvent,
	type TestProject,
} from './utils';

const BASE = 'http://localhost';

describe('security config role gating', () => {
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let project: TestProject;

	beforeEach(async () => {
		owner = await createTestUser({
			email: `owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Owner User',
		});
		member = await createTestUser({
			email: `member-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
			password: 'testpassword123',
			name: 'Member User',
		});
		project = await createTestProject(owner.token!, {
			name: `RoleGate ${Date.now()}`,
			platform: 'javascript',
		});

		// Add the second user as a plain member (membership is admin-managed)
		const add = await adminFetch(`${BASE}/api/admin/projects/${project.id}/members`, {
			method: 'POST',
			body: JSON.stringify({ email: member.email, role: 'member' }),
		});
		expect(add.status).toBeLessThan(300);
	});

	it('rejects retention/rate-limit changes from plain members', async () => {
		const response = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ retentionDays: 1 }),
			},
		);
		expect(response.status).toBe(403);

		const response2 = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ maxEventsPerHour: 10 }),
			},
		);
		expect(response2.status).toBe(403);
	});

	it('allows retention/rate-limit changes from the owner', async () => {
		const response = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ retentionDays: 365, maxEventsPerHour: 5000 }),
			},
		);
		expect(response.status).toBeLessThan(300);
	});

	it('rejects filter writes from plain members', async () => {
		const create = await authFetch(
			member.token!,
			`http://localhost/api/projects/${project.slug}/filters`,
			{
				method: 'POST',
				body: JSON.stringify({ filterType: 'message', pattern: 'noise' }),
			},
		);
		expect(create.status).toBe(403);
	});

	it('allows filter management from the owner', async () => {
		const create = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/filters`,
			{
				method: 'POST',
				body: JSON.stringify({ filterType: 'message', pattern: 'noise' }),
			},
		);
		expect(create.status).toBeLessThan(300);
	});

	describe('deleting issues and source maps (owner/admin only)', () => {
		async function newIssueId(): Promise<string> {
			// letters only: the fingerprint normalizes digits and UUIDs, which
			// would fold every probe into one issue
			const word = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) =>
				String.fromCharCode(65 + (b % 26)),
			).join('');
			const type = `RoleGate${word}Error`;
			await sendTestEvent(project.id, project.publicKey, {
				exception: { type, value: 'gate probe' },
			});
			const list = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${project.slug}/issues?status=unresolved`,
			);
			const { issues } = (await list.json()) as { issues: Array<{ id: string; title: string }> };
			const issue = issues.find((i) => i.title.includes(type));
			expect(issue).toBeDefined();
			return issue!.id;
		}

		async function uploadSourceMap(token: string): Promise<{ status: number; id?: string }> {
			const response = await authFetch(token, `${BASE}/api/projects/${project.slug}/sourcemaps`, {
				method: 'POST',
				body: JSON.stringify({
					release: `app@${crypto.randomUUID().slice(0, 6)}`,
					fileUrl: 'https://example.com/assets/main.js',
					content: JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' }),
				}),
			});
			const data = (await response.json()) as { sourceMap?: { id: string } };
			return { status: response.status, id: data.sourceMap?.id };
		}

		it('refuses issue deletes from plain members on every path', async () => {
			const issueId = await newIssueId();

			const single = await authFetch(
				member.token!,
				`${BASE}/api/projects/${project.slug}/issues/${issueId}`,
				{
					method: 'DELETE',
				},
			);
			expect(single.status).toBe(403);

			const bulk = await authFetch(
				member.token!,
				`${BASE}/api/projects/${project.slug}/issues/bulk`,
				{
					method: 'PATCH',
					body: JSON.stringify({ issueIds: [issueId], action: 'delete' }),
				},
			);
			expect(bulk.status).toBe(403);

			const api0 = await authFetch(member.token!, `${BASE}/api/0/issues/${issueId}/`, {
				method: 'DELETE',
			});
			expect(api0.status).toBe(403);
			expect(((await api0.json()) as { detail: string }).detail).toContain('owners and admins');

			// still there
			const detail = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${project.slug}/issues/${issueId}`,
			);
			expect(detail.status).toBe(200);
		});

		it('still lets plain members triage in bulk', async () => {
			const issueId = await newIssueId();
			const bulk = await authFetch(
				member.token!,
				`${BASE}/api/projects/${project.slug}/issues/bulk`,
				{
					method: 'PATCH',
					body: JSON.stringify({ issueIds: [issueId], status: 'resolved' }),
				},
			);
			expect(bulk.status).toBe(200);
		});

		it('lets the owner delete issues (single, bulk and /api/0)', async () => {
			const [a, b, c] = [await newIssueId(), await newIssueId(), await newIssueId()];
			expect(
				(
					await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/issues/${a}`, {
						method: 'DELETE',
					})
				).status,
			).toBe(200);
			expect(
				(
					await authFetch(owner.token!, `${BASE}/api/projects/${project.slug}/issues/bulk`, {
						method: 'PATCH',
						body: JSON.stringify({ issueIds: [b], action: 'delete' }),
					})
				).status,
			).toBe(200);
			expect(
				(await authFetch(owner.token!, `${BASE}/api/0/issues/${c}/`, { method: 'DELETE' })).status,
			).toBe(202);
		});

		it('members upload source maps but only owners/admins delete them', async () => {
			const uploaded = await uploadSourceMap(member.token!);
			expect(uploaded.status).toBe(200);

			const asMember = await authFetch(
				member.token!,
				`${BASE}/api/projects/${project.slug}/sourcemaps/${uploaded.id}`,
				{
					method: 'DELETE',
				},
			);
			expect(asMember.status).toBe(403);

			const asOwner = await authFetch(
				owner.token!,
				`${BASE}/api/projects/${project.slug}/sourcemaps/${uploaded.id}`,
				{
					method: 'DELETE',
				},
			);
			expect(asOwner.status).toBe(200);
		});
	});
});
