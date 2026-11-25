import type { Context } from 'hono';
import type { AuthContext, Env, Project } from '../types';

type Variables = {
	auth?: AuthContext;
};

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Resolve a project slug for the authenticated user and return it with the
 * caller's membership role, or an error Response. Membership is mandatory:
 * AuthState's `get-project` has no unscoped branch, so non-members and
 * cross-project callers get the same 404 without learning whether the slug
 * exists.
 */
export async function getProjectWithAccess(
	c: AppContext,
	slug: string,
): Promise<{ project: Project; memberRole: string } | Response> {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!response.ok) {
		return c.json({ error: 'project_not_found' }, 404);
	}

	return response.json();
}

/**
 * Project roles that may run destructive or security-relevant project
 * actions: change security settings and filters, rotate the DSN key, and
 * delete issues or source maps. Plain `member`s triage, comment and upload.
 */
export function canManageProject(memberRole: string | null | undefined): boolean {
	return memberRole === 'owner' || memberRole === 'admin';
}

/** 403 unless the caller is the project's owner or an admin; null otherwise. */
export function requireProjectManager(
	c: Context,
	memberRole: string | null | undefined,
	action: string,
): Response | null {
	if (canManageProject(memberRole)) return null;
	return c.json(
		{ error: 'forbidden', message: `Only project owners and admins can ${action}` },
		403,
	);
}

/**
 * Whether a DSN/URL project id refers to `project`. Accepts the numeric
 * ingest id (what current DSNs carry, since Sentry SDKs require numeric
 * project ids) and the legacy UUID (DSNs issued before ingest ids existed).
 */
export function isProjectIdForProject(
	projectId: string,
	project: { id: string; ingestId?: number | null },
): boolean {
	if (projectId === project.id) return true;
	return project.ingestId != null && projectId === String(project.ingestId);
}
