import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readCappedJson } from '../lib/capped-json';
import { purgeProjectState } from '../lib/project-purge';
import { auditVia, requireScope } from '../lib/token-scopes';
import { buildWebhookPayload } from '../lib/webhook';
import type { AuthContext, Env } from '../types';

type Variables = {
	auth?: AuthContext;
};

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// List all projects for the current user
projectRoutes.get('/', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const response = await authState.fetch(
		new Request('http://internal/list-projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: auth.user.id }),
		}),
	);

	const data = await response.json();
	return c.json(data);
});

// Project creation is admin-only: POST /api/admin/projects (with an
// assigned owner). This router keeps the member-facing read/settings
// surface and the owner-delete path.

// Get a specific project by slug
projectRoutes.get('/:slug', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const slug = c.req.param('slug');

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
		const error = await response.json();
		return c.json(error, response.status as ContentfulStatusCode);
	}

	const data = (await response.json()) as {
		project: { id: string; publicKey: string; ingestId?: number | null };
	};

	// Generate DSN
	const host = new URL(c.req.url).host;
	const dsn = `https://${data.project.publicKey}@${host}/${data.project.ingestId ?? data.project.id}`;

	return c.json({ ...data, dsn });
});

/** DSN for a project, from the host the request reached (same as the read routes). */
function dsnFor(
	c: { req: { url: string } },
	project: { publicKey: string; ingestId?: number | null; id: string },
) {
	const host = new URL(c.req.url).host;
	return `https://${project.publicKey}@${host}/${project.ingestId ?? project.id}`;
}

const MAX_PROJECT_BODY_BYTES = 16 * 1024;

// Create a project owned by the caller
// POST /api/projects  { name, platform? }  → 201 { project, dsn }
//
// Same bar as the admin area: the caller must be an admin, and either a
// passkey-minted session or an API token with the `projects` scope (which
// only an admin in a passkey session can mint). The creator becomes owner.
projectRoutes.post('/', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	if (auth.user.role !== 'admin') {
		return c.json({ error: 'forbidden', message: 'Only admins can create projects' }, 403);
	}
	if (auth.apiToken) {
		const denied = requireScope(c, auth, 'projects');
		if (denied) return denied;
	} else if (auth.session.authMethod !== 'passkey') {
		return c.json(
			{
				error: 'passkey_required',
				message: 'Creating projects requires signing in with a passkey',
			},
			403,
		);
	}

	const parsed = await readCappedJson(c, MAX_PROJECT_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const { name, platform } = parsed.body as { name?: unknown; platform?: unknown };
	if (typeof name !== 'string' || name.trim().length === 0) {
		return c.json({ error: 'missing_fields', message: 'name is required' }, 400);
	}

	const authState = c.env.AUTH_STATE.get(c.env.AUTH_STATE.idFromName('global'));
	const response = await authState.fetch(
		new Request('http://internal/admin/create-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				requestingUserId: auth.user.id,
				requestingUserRole: auth.user.role,
				name: name.trim(),
				platform,
				ownerId: auth.user.id,
				via: auditVia(auth),
			}),
		}),
	);
	const data = (await response.json()) as {
		project?: { id: string; publicKey: string; ingestId?: number | null };
	} & Record<string, unknown>;
	if (!response.ok || !data.project) {
		return c.json(data, response.status as ContentfulStatusCode);
	}
	return c.json({ ...data, dsn: dsnFor(c, data.project) }, 201);
});

// Replace the project's DSN key; the old key stops working at once
// POST /api/projects/:slug/rotate-key  → { project, dsn }
projectRoutes.post('/:slug/rotate-key', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	const denied = requireScope(c, auth, 'projects');
	if (denied) return denied;

	const authState = c.env.AUTH_STATE.get(c.env.AUTH_STATE.idFromName('global'));
	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug: c.req.param('slug'), userId: auth.user.id }),
		}),
	);
	if (!getResponse.ok) {
		return c.json(await getResponse.json(), getResponse.status as ContentfulStatusCode);
	}
	const { project } = (await getResponse.json()) as { project: { id: string } };

	const response = await authState.fetch(
		new Request('http://internal/rotate-project-key', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: project.id, userId: auth.user.id, via: auditVia(auth) }),
		}),
	);
	const data = (await response.json()) as {
		project?: { id: string; publicKey: string; ingestId?: number | null };
	} & Record<string, unknown>;
	if (!response.ok || !data.project) {
		return c.json(data, response.status as ContentfulStatusCode);
	}
	return c.json({ ...data, dsn: dsnFor(c, data.project) });
});

// Get project settings
projectRoutes.get('/:slug/settings', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const slug = c.req.param('slug');

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
		const error = await response.json();
		return c.json(error, response.status as 404);
	}

	const { project } = (await response.json()) as { project: { id: string } };

	const projectStateId = c.env.PROJECT_STATE.idFromName(project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	const settingsResponse = await projectState.fetch(new Request('http://internal/settings'));

	const data = await settingsResponse.json();
	return c.json(data);
});

// Update a project
projectRoutes.patch('/:slug', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const slug = c.req.param('slug');
	const body = await c.req.json<{
		webhookUrl?: string | null;
		maxEventsPerHour?: number;
		retentionDays?: number;
		scrubHeaders?: string[];
		maxAttachmentBytes?: number;
		name?: string;
		platform?: string;
	}>();

	if (
		body.name === undefined &&
		body.platform === undefined &&
		body.webhookUrl === undefined &&
		body.maxEventsPerHour === undefined &&
		body.retentionDays === undefined &&
		body.scrubHeaders === undefined &&
		body.maxAttachmentBytes === undefined
	) {
		return c.json({ error: 'no_updates', message: 'No fields to update were provided' }, 400);
	}

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	// Get project first
	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!getResponse.ok) {
		const error = await getResponse.json();
		return c.json(error, getResponse.status as ContentfulStatusCode);
	}

	const projectData = (await getResponse.json()) as {
		project: { id: string };
		memberRole?: string;
	};

	// Security-relevant project config (rate limits, retention, scrubbing,
	// attachment budget) requires owner/admin, mirroring the webhookUrl gate
	// in AuthState.
	if (
		body.maxEventsPerHour !== undefined ||
		body.retentionDays !== undefined ||
		body.scrubHeaders !== undefined ||
		body.maxAttachmentBytes !== undefined
	) {
		if (projectData.memberRole !== 'owner' && projectData.memberRole !== 'admin') {
			return c.json(
				{
					error: 'forbidden',
					message: 'Only project owners and admins can change security settings',
				},
				403,
			);
		}
	}

	const result: Record<string, unknown> = {};

	// Name, platform and webhook URL live in AuthState (owner/admin; name
	// and platform changes are audited). Sent first so a bad value fails the
	// request before any ProjectState setting changes.
	if (body.webhookUrl !== undefined || body.name !== undefined || body.platform !== undefined) {
		const updateResponse = await authState.fetch(
			new Request('http://internal/update-project', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId: projectData.project.id,
					userId: auth.user.id,
					webhookUrl: body.webhookUrl,
					name: body.name,
					platform: body.platform,
					via: auditVia(auth),
				}),
			}),
		);

		const data = (await updateResponse.json()) as Record<string, unknown>;
		if (!updateResponse.ok) {
			return c.json(data, updateResponse.status as ContentfulStatusCode);
		}

		Object.assign(result, data);
	}

	// Update rate limit config in ProjectState if provided
	if (body.maxEventsPerHour !== undefined) {
		const projectStateId = c.env.PROJECT_STATE.idFromName(projectData.project.id);
		const projectState = c.env.PROJECT_STATE.get(projectStateId);

		const configResponse = await projectState.fetch(
			new Request('http://internal/config/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ maxEventsPerHour: body.maxEventsPerHour }),
			}),
		);

		const data = (await configResponse.json()) as Record<string, unknown>;
		if (!configResponse.ok) {
			return c.json(data, configResponse.status as ContentfulStatusCode);
		}

		Object.assign(result, data);
	}

	// Update attachment budget config in ProjectState if provided
	if (body.maxAttachmentBytes !== undefined) {
		const projectStateId = c.env.PROJECT_STATE.idFromName(projectData.project.id);
		const projectState = c.env.PROJECT_STATE.get(projectStateId);

		const configResponse = await projectState.fetch(
			new Request('http://internal/config/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					maxAttachmentBytes: body.maxAttachmentBytes,
				}),
			}),
		);

		const data = (await configResponse.json()) as Record<string, unknown>;
		if (!configResponse.ok) {
			return c.json(data, configResponse.status as ContentfulStatusCode);
		}

		Object.assign(result, data);
	}

	// Update retention/scrub settings in ProjectState if provided
	if (body.retentionDays !== undefined || body.scrubHeaders !== undefined) {
		const projectStateId = c.env.PROJECT_STATE.idFromName(projectData.project.id);
		const projectState = c.env.PROJECT_STATE.get(projectStateId);

		const settingsResponse = await projectState.fetch(
			new Request('http://internal/settings/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					retentionDays: body.retentionDays === undefined ? 0 : body.retentionDays,
					scrubHeaders: body.scrubHeaders,
				}),
			}),
		);

		const settingsData = (await settingsResponse.json()) as Record<string, unknown>;
		if (!settingsResponse.ok) {
			return c.json(settingsData, settingsResponse.status as ContentfulStatusCode);
		}

		Object.assign(result, settingsData);
	}

	return c.json(Object.keys(result).length > 0 ? result : { success: true });
});

// Get rate limit status for a project
projectRoutes.get('/:slug/rate-limit', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const slug = c.req.param('slug');
	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!getResponse.ok) {
		const error = await getResponse.json();
		return c.json(error, getResponse.status as ContentfulStatusCode);
	}

	const projectData = (await getResponse.json()) as { project: { id: string } };
	const projectStateId = c.env.PROJECT_STATE.idFromName(projectData.project.id);
	const projectState = c.env.PROJECT_STATE.get(projectStateId);

	const response = await projectState.fetch(new Request('http://internal/rate-limit-status'));
	return c.json(await response.json());
});

// Test webhook
projectRoutes.post('/:slug/test-webhook', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}

	const slug = c.req.param('slug');

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!getResponse.ok) {
		const error = await getResponse.json();
		return c.json(error, getResponse.status as ContentfulStatusCode);
	}

	const projectData = (await getResponse.json()) as {
		project: { id: string; name: string; slug: string; webhookUrl?: string | null };
	};
	const project = projectData.project;

	if (!project.webhookUrl) {
		return c.json({ error: 'no_webhook', message: 'No webhook URL configured' }, 400);
	}

	const payload = buildWebhookPayload(
		{ id: project.id, name: project.name, slug: project.slug },
		{ id: 'test-issue-id', title: 'Test Issue', level: 'info', culprit: null },
	);

	try {
		const response = await fetch(project.webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const body = await response.text();
		if (!response.ok) {
			return c.json(
				{ error: 'webhook_failed', message: `Webhook returned ${response.status}`, body },
				502,
			);
		}
		return c.json({ success: true });
	} catch (err) {
		return c.json(
			{
				error: 'webhook_error',
				message: err instanceof Error ? err.message : 'Failed to reach webhook URL',
			},
			502,
		);
	}
});

// Delete a project
projectRoutes.delete('/:slug', async (c) => {
	const auth = c.get('auth');
	if (!auth) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	const denied = requireScope(c, auth, 'projects');
	if (denied) return denied;

	const slug = c.req.param('slug');

	const authStateId = c.env.AUTH_STATE.idFromName('global');
	const authState = c.env.AUTH_STATE.get(authStateId);

	// First get the project to get its ID
	const getResponse = await authState.fetch(
		new Request('http://internal/get-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ slug, userId: auth.user.id }),
		}),
	);

	if (!getResponse.ok) {
		const error = await getResponse.json();
		return c.json(error, getResponse.status as ContentfulStatusCode);
	}

	const projectData = (await getResponse.json()) as { project: { id: string } };

	// Delete the project
	const deleteResponse = await authState.fetch(
		new Request('http://internal/delete-project', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				projectId: projectData.project.id,
				userId: auth.user.id,
				via: auditVia(auth),
			}),
		}),
	);

	if (!deleteResponse.ok) {
		const data = await deleteResponse.json();
		return c.json(data, deleteResponse.status as ContentfulStatusCode);
	}

	// Purge the ProjectState Durable Object so events, source maps, comments
	// and stats do not outlive the deleted project (shared saga with the
	// admin delete route; see lib/project-purge.ts).
	await purgeProjectState(c.env, projectData.project.id, {
		faultHeader: c.req.header('X-Sentinel-Test-Fault'),
	});

	const data = await deleteResponse.json();
	return c.json(data, deleteResponse.status as ContentfulStatusCode);
});
