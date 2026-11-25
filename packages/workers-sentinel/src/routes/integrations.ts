/**
 * Project integrations — Kaneo first (docs/plano-mcp-e-tenho-horario.md,
 * "Fase 4"). Configuration is per project and owner/admin only; the Kaneo
 * API key and Access service token are sealed with INTEGRATIONS_KEY
 * (lib/secret-box.ts) and only ever leave this module masked.
 *
 *   GET    /api/projects/:slug/integrations/kaneo           current config (masked)
 *   POST   /api/projects/:slug/integrations/kaneo/discover  list workspaces/projects/columns
 *   PUT    /api/projects/:slug/integrations/kaneo           create or update
 *   POST   /api/projects/:slug/integrations/kaneo/test      check the stored connection
 *   DELETE /api/projects/:slug/integrations/kaneo           disconnect
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readCappedJson } from '../lib/capped-json';
import {
	createKaneoClient,
	type KaneoClient,
	type KaneoColumn,
	type KaneoCredentials,
	KaneoError,
	normalizeKaneoBaseUrl,
} from '../lib/kaneo';
import {
	type AppContext,
	getProjectWithAccess,
	requireProjectManager,
} from '../lib/project-access';
import { maskSecret, openSecret, SecretBoxError, sealSecret } from '../lib/secret-box';
import { auditVia } from '../lib/token-scopes';
import type { AuthContext, Env, Project } from '../types';

type Variables = {
	auth?: AuthContext;
};

type Ctx = AppContext;

export const integrationRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_BODY_BYTES = 16 * 1024;
export const ISSUE_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;
export type IssueLevel = (typeof ISSUE_LEVELS)[number];
const MAX_ENVIRONMENTS = 20;
const MAX_ENVIRONMENT_LENGTH = 64;

/** What is stored in `integrations.config` for a Kaneo integration. */
export interface KaneoConfig {
	baseUrl: string;
	workspaceId: string;
	kaneoProjectId: string;
	kaneoProjectName: string;
	kaneoProjectSlug: string;
	createColumn: string;
	doneColumn: string;
	reopenColumn: string;
	autoCreate: boolean;
	minLevel: IssueLevel;
	environments: string[];
}

/** Stored integration row as ProjectState returns it (ciphertexts sealed). */
export interface StoredIntegration {
	id: string;
	type: string;
	enabled: boolean;
	config: Record<string, unknown>;
	secretCipher: string;
	webhookSecretCipher: string | null;
	lastError: string | null;
	lastErrorAt: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the issue-link and hook routes)
// ---------------------------------------------------------------------------

function projectState(env: Env, projectId: string) {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
}

export async function loadIntegration(
	env: Env,
	projectId: string,
	type: string,
): Promise<StoredIntegration | null> {
	const response = await projectState(env, projectId).fetch(
		new Request('http://internal/integrations/get', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type }),
		}),
	);
	const data = (await response.json()) as { integration: StoredIntegration | null };
	return data.integration;
}

export async function openKaneoCredentials(
	env: Env,
	projectId: string,
	integration: StoredIntegration,
): Promise<KaneoCredentials> {
	const plaintext = await openSecret(
		env.INTEGRATIONS_KEY as string,
		projectId,
		integration.secretCipher,
	);
	return JSON.parse(plaintext) as KaneoCredentials;
}

/** Map a Kaneo failure to the response the caller sees. */
export function kaneoFailure(c: Ctx, error: unknown): Response {
	if (error instanceof KaneoError) {
		const status: ContentfulStatusCode = error.code === 'invalid_url' ? 400 : 502;
		return c.json({ error: 'kaneo_failed', code: error.code, message: error.message }, status);
	}
	if (error instanceof SecretBoxError) {
		return c.json(
			{
				error: 'integration_secret_unreadable',
				message:
					'The stored Kaneo credentials could not be decrypted (was INTEGRATIONS_KEY changed?). Enter them again.',
			},
			409,
		);
	}
	throw error;
}

function integrationsUnconfigured(c: Ctx): Response | null {
	if (c.env.INTEGRATIONS_KEY && c.env.INTEGRATIONS_KEY.length >= 32) return null;
	return c.json(
		{
			error: 'integrations_unconfigured',
			message: 'Integrations need the INTEGRATIONS_KEY secret on this Sentinel instance',
		},
		503,
	);
}

async function managedProject(
	c: Ctx,
	action: string,
): Promise<{ project: Project; auth: AuthContext } | Response> {
	const auth = c.get('auth');
	if (!auth) return c.json({ error: 'unauthorized' }, 401);
	const access = await getProjectWithAccess(c, c.req.param('slug') as string);
	if (access instanceof Response) return access;
	const denied = requireProjectManager(c, access.memberRole, action);
	if (denied) return denied;
	return { project: access.project, auth };
}

async function writeAudit(
	env: Env,
	auth: AuthContext,
	action: string,
	project: Project,
	details: Record<string, unknown>,
): Promise<void> {
	const authState = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
	await authState.fetch(
		new Request('http://internal/audit/append', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				userId: auth.user.id,
				action,
				targetType: 'project',
				targetId: project.id,
				targetLabel: project.name,
				details: { slug: project.slug, ...details, ...auditVia(auth) },
			}),
		}),
	);
}

/** The integration as the dashboard and API see it: secrets masked. */
export function kaneoView(integration: StoredIntegration, credentials: KaneoCredentials | null) {
	const config = integration.config as unknown as KaneoConfig;
	return {
		id: integration.id,
		type: 'kaneo' as const,
		enabled: integration.enabled,
		baseUrl: config.baseUrl,
		workspaceId: config.workspaceId,
		kaneoProjectId: config.kaneoProjectId,
		kaneoProjectName: config.kaneoProjectName,
		kaneoProjectSlug: config.kaneoProjectSlug,
		createColumn: config.createColumn,
		doneColumn: config.doneColumn,
		reopenColumn: config.reopenColumn,
		autoCreate: config.autoCreate,
		minLevel: config.minLevel,
		environments: config.environments,
		apiKey: maskSecret(credentials?.apiKey),
		accessClientId: maskSecret(credentials?.accessClientId),
		hasAccessToken: Boolean(credentials?.accessClientId && credentials?.accessClientSecret),
		credentialsReadable: credentials !== null,
		lastError: integration.lastError,
		lastErrorAt: integration.lastErrorAt,
		createdAt: integration.createdAt,
		updatedAt: integration.updatedAt,
	};
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

type CredentialPatch = {
	baseUrl?: string;
	apiKey?: string;
	/** null clears the Access service token. */
	accessClientId?: string | null;
	accessClientSecret?: string | null;
};

function optionalString(value: unknown, field: string, max = 512): string | undefined | Error {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') return new Error(`${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.length > max) return new Error(`${field} is too long`);
	return trimmed;
}

function parseCredentialPatch(body: Record<string, unknown>): CredentialPatch | Error {
	const patch: CredentialPatch = {};
	for (const field of ['baseUrl', 'apiKey'] as const) {
		const value = optionalString(body[field], field);
		if (value instanceof Error) return value;
		if (value !== undefined) patch[field] = value;
	}
	for (const field of ['accessClientId', 'accessClientSecret'] as const) {
		if (body[field] === null) {
			patch[field] = null;
			continue;
		}
		const value = optionalString(body[field], field);
		if (value instanceof Error) return value;
		if (value !== undefined) patch[field] = value;
	}
	return patch;
}

/** Merge a patch over stored credentials; the Access id and secret go together. */
function mergeCredentials(
	stored: KaneoCredentials | null,
	patch: CredentialPatch,
): KaneoCredentials | Error {
	const apiKey = patch.apiKey ?? stored?.apiKey;
	if (!apiKey) return new Error('apiKey is required');
	let accessClientId = stored?.accessClientId ?? null;
	let accessClientSecret = stored?.accessClientSecret ?? null;
	if (patch.accessClientId !== undefined || patch.accessClientSecret !== undefined) {
		if (patch.accessClientId === null || patch.accessClientSecret === null) {
			accessClientId = null;
			accessClientSecret = null;
		} else {
			accessClientId = patch.accessClientId ?? accessClientId;
			accessClientSecret = patch.accessClientSecret ?? accessClientSecret;
		}
	}
	if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
		return new Error('The Access service token needs both the client id and the client secret');
	}
	return { apiKey, accessClientId, accessClientSecret };
}

function pickColumn(columns: KaneoColumn[], requested: unknown, fallback: string): string | Error {
	if (requested !== undefined && requested !== null && requested !== '') {
		if (typeof requested !== 'string' || !columns.some((col) => col.slug === requested)) {
			return new Error(`Kaneo column "${String(requested)}" does not exist in that project`);
		}
		return requested;
	}
	return fallback;
}

/** Default columns: "to-do" (or the first open column) and the first final column. */
function defaultColumns(columns: KaneoColumn[]): { open: string; done: string } | null {
	const sorted = [...columns].sort((a, b) => a.position - b.position);
	const open =
		sorted.find((col) => col.slug === 'to-do' && !col.isFinal) ??
		sorted.find((col) => !col.isFinal);
	const done = sorted.find((col) => col.isFinal) ?? sorted.find((col) => col.slug === 'done');
	if (!open || !done) return null;
	return { open: open.slug, done: done.slug };
}

function parseEnvironments(value: unknown, fallback: string[]): string[] | Error {
	if (value === undefined) return fallback;
	if (!Array.isArray(value)) return new Error('environments must be a list of names');
	const names = value
		.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
		.filter((entry) => entry.length > 0);
	if (names.length > MAX_ENVIRONMENTS) return new Error('Too many environments');
	if (names.some((name) => name.length > MAX_ENVIRONMENT_LENGTH)) {
		return new Error('Environment names are limited to 64 characters');
	}
	return [...new Set(names)];
}

function badRequest(c: Ctx, error: Error): Response {
	return c.json({ error: 'invalid_integration', message: error.message }, 400);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

integrationRoutes.get('/:slug/integrations/kaneo', async (c) => {
	const ctx = await managedProject(c, 'view integrations');
	if (ctx instanceof Response) return ctx;
	const configured = !integrationsUnconfigured(c);
	const integration = await loadIntegration(c.env, ctx.project.id, 'kaneo');
	if (!integration) return c.json({ configured, integration: null });
	let credentials: KaneoCredentials | null = null;
	if (configured) {
		try {
			credentials = await openKaneoCredentials(c.env, ctx.project.id, integration);
		} catch {
			credentials = null;
		}
	}
	return c.json({ configured, integration: kaneoView(integration, credentials) });
});

/**
 * List what the given (or stored) credentials can see: workspaces, the
 * projects of `workspaceId`, and the columns of `kaneoProjectId`. Lets the
 * settings form offer pickers instead of asking for raw ids.
 */
integrationRoutes.post('/:slug/integrations/kaneo/discover', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const parsed = await readCappedJson(c, MAX_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const patch = parseCredentialPatch(parsed.body);
	if (patch instanceof Error) return badRequest(c, patch);

	const stored = await loadIntegration(c.env, ctx.project.id, 'kaneo');
	let storedCredentials: KaneoCredentials | null = null;
	try {
		storedCredentials = stored ? await openKaneoCredentials(c.env, ctx.project.id, stored) : null;
	} catch (error) {
		if (!patch.apiKey) return kaneoFailure(c, error);
	}
	const credentials = mergeCredentials(storedCredentials, patch);
	if (credentials instanceof Error) return badRequest(c, credentials);
	const baseUrl = patch.baseUrl ?? (stored?.config as KaneoConfig | undefined)?.baseUrl;
	if (!baseUrl) return badRequest(c, new Error('baseUrl is required'));

	const workspaceId = optionalString(parsed.body.workspaceId, 'workspaceId', 128);
	const kaneoProjectId = optionalString(parsed.body.kaneoProjectId, 'kaneoProjectId', 128);
	if (workspaceId instanceof Error) return badRequest(c, workspaceId);
	if (kaneoProjectId instanceof Error) return badRequest(c, kaneoProjectId);

	try {
		const client = createKaneoClient(baseUrl, credentials);
		const workspaces = await client.listWorkspaces();
		const projects = workspaceId ? await client.listProjects(workspaceId) : undefined;
		const columns = kaneoProjectId ? await client.listColumns(kaneoProjectId) : undefined;
		return c.json({
			baseUrl: client.origin,
			workspaces: workspaces.map(({ id, name, slug }) => ({ id, name, slug })),
			projects: projects?.map(({ id, name, slug, workspaceId: ws }) => ({
				id,
				name,
				slug,
				workspaceId: ws,
			})),
			columns: columns?.map(({ id, name, slug, position, isFinal }) => ({
				id,
				name,
				slug,
				position,
				isFinal,
			})),
		});
	} catch (error) {
		return kaneoFailure(c, error);
	}
});

integrationRoutes.put('/:slug/integrations/kaneo', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const parsed = await readCappedJson(c, MAX_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const patch = parseCredentialPatch(body);
	if (patch instanceof Error) return badRequest(c, patch);

	const stored = await loadIntegration(c.env, ctx.project.id, 'kaneo');
	const storedConfig = stored ? (stored.config as unknown as KaneoConfig) : null;
	let storedCredentials: KaneoCredentials | null = null;
	if (stored) {
		try {
			storedCredentials = await openKaneoCredentials(c.env, ctx.project.id, stored);
		} catch (error) {
			// Unreadable (INTEGRATIONS_KEY rotated): a full re-entry recovers it.
			if (!patch.apiKey) return kaneoFailure(c, error);
		}
	}
	const credentials = mergeCredentials(storedCredentials, patch);
	if (credentials instanceof Error) return badRequest(c, credentials);

	const rawBaseUrl = patch.baseUrl ?? storedConfig?.baseUrl;
	if (!rawBaseUrl) return badRequest(c, new Error('baseUrl is required'));
	const base = normalizeKaneoBaseUrl(rawBaseUrl);
	if (!base.ok) return badRequest(c, new Error(base.reason));

	const kaneoProjectId = optionalString(body.kaneoProjectId, 'kaneoProjectId', 128);
	if (kaneoProjectId instanceof Error) return badRequest(c, kaneoProjectId);
	const targetProjectId = kaneoProjectId ?? storedConfig?.kaneoProjectId;
	if (!targetProjectId) return badRequest(c, new Error('kaneoProjectId is required'));

	const minLevel = body.minLevel ?? storedConfig?.minLevel ?? 'error';
	if (!ISSUE_LEVELS.includes(minLevel as IssueLevel)) {
		return badRequest(c, new Error(`minLevel must be one of ${ISSUE_LEVELS.join(', ')}`));
	}
	if (body.autoCreate !== undefined && typeof body.autoCreate !== 'boolean') {
		return badRequest(c, new Error('autoCreate must be true or false'));
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		return badRequest(c, new Error('enabled must be true or false'));
	}
	const environments = parseEnvironments(body.environments, storedConfig?.environments ?? []);
	if (environments instanceof Error) return badRequest(c, environments);

	// Validate against Kaneo itself before storing anything.
	let client: KaneoClient;
	let kaneoProject: Awaited<ReturnType<KaneoClient['getProject']>>;
	let columns: KaneoColumn[];
	try {
		client = createKaneoClient(base.origin, credentials);
		kaneoProject = await client.getProject(targetProjectId);
		columns = await client.listColumns(targetProjectId);
	} catch (error) {
		return kaneoFailure(c, error);
	}
	const defaults = defaultColumns(columns);
	if (!defaults) {
		return badRequest(c, new Error('That Kaneo project needs an open column and a final column'));
	}
	// A project change resets column choices the new project may not have.
	const sameProject = storedConfig?.kaneoProjectId === targetProjectId;
	const createColumn = pickColumn(
		columns,
		body.createColumn,
		sameProject && storedConfig ? storedConfig.createColumn : defaults.open,
	);
	if (createColumn instanceof Error) return badRequest(c, createColumn);
	const doneColumn = pickColumn(
		columns,
		body.doneColumn,
		sameProject && storedConfig ? storedConfig.doneColumn : defaults.done,
	);
	if (doneColumn instanceof Error) return badRequest(c, doneColumn);
	const reopenColumn = pickColumn(
		columns,
		body.reopenColumn,
		sameProject && storedConfig ? storedConfig.reopenColumn : createColumn,
	);
	if (reopenColumn instanceof Error) return badRequest(c, reopenColumn);
	if (doneColumn === createColumn || doneColumn === reopenColumn) {
		return badRequest(c, new Error('The done column must differ from the open columns'));
	}

	const config: KaneoConfig = {
		baseUrl: base.origin,
		workspaceId: kaneoProject.workspaceId,
		kaneoProjectId: kaneoProject.id,
		kaneoProjectName: kaneoProject.name,
		kaneoProjectSlug: kaneoProject.slug,
		createColumn,
		doneColumn,
		reopenColumn,
		autoCreate: (body.autoCreate as boolean | undefined) ?? storedConfig?.autoCreate ?? false,
		minLevel: minLevel as IssueLevel,
		environments,
	};

	const credentialsChanged =
		!storedCredentials ||
		storedCredentials.apiKey !== credentials.apiKey ||
		(storedCredentials.accessClientId ?? null) !== (credentials.accessClientId ?? null) ||
		(storedCredentials.accessClientSecret ?? null) !== (credentials.accessClientSecret ?? null);
	const secretCipher = credentialsChanged
		? await sealSecret(
				c.env.INTEGRATIONS_KEY as string,
				ctx.project.id,
				JSON.stringify(credentials),
			)
		: undefined;

	const saveResponse = await projectState(c.env, ctx.project.id).fetch(
		new Request('http://internal/integrations/save', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'kaneo',
				enabled: (body.enabled as boolean | undefined) ?? stored?.enabled ?? true,
				config,
				secretCipher,
			}),
		}),
	);
	const saved = (await saveResponse.json()) as {
		integration: StoredIntegration;
		created: boolean;
	};
	if (!saveResponse.ok) {
		return c.json(saved, saveResponse.status as ContentfulStatusCode);
	}

	const changedFields = storedConfig
		? (Object.keys(config) as (keyof KaneoConfig)[]).filter(
				(key) => JSON.stringify(config[key]) !== JSON.stringify(storedConfig[key]),
			)
		: undefined;
	await writeAudit(
		c.env,
		ctx.auth,
		saved.created ? 'integration.created' : 'integration.updated',
		ctx.project,
		{
			integration: 'kaneo',
			kaneoProjectId: config.kaneoProjectId,
			...(changedFields ? { fields: changedFields } : {}),
		},
	);
	if (credentialsChanged && !saved.created) {
		await writeAudit(c.env, ctx.auth, 'integration.key_changed', ctx.project, {
			integration: 'kaneo',
		});
	}

	return c.json(
		{ integration: kaneoView(saved.integration, credentials) },
		saved.created ? 201 : 200,
	);
});

/** Check the stored connection: credentials, project and the configured columns. */
integrationRoutes.post('/:slug/integrations/kaneo/test', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const integration = await loadIntegration(c.env, ctx.project.id, 'kaneo');
	if (!integration) {
		return c.json({ error: 'no_integration', message: 'Kaneo is not connected' }, 404);
	}
	const config = integration.config as unknown as KaneoConfig;
	try {
		const credentials = await openKaneoCredentials(c.env, ctx.project.id, integration);
		const client = createKaneoClient(config.baseUrl, credentials);
		const project = await client.getProject(config.kaneoProjectId);
		const columns = await client.listColumns(config.kaneoProjectId);
		const missing = [config.createColumn, config.doneColumn, config.reopenColumn].filter(
			(slug) => !columns.some((col) => col.slug === slug),
		);
		if (missing.length > 0) {
			return c.json(
				{
					error: 'kaneo_columns_missing',
					message: `These Kaneo columns no longer exist: ${[...new Set(missing)].join(', ')}`,
				},
				409,
			);
		}
		return c.json({
			ok: true,
			project: { id: project.id, name: project.name, slug: project.slug },
		});
	} catch (error) {
		return kaneoFailure(c, error);
	}
});

integrationRoutes.delete('/:slug/integrations/kaneo', async (c) => {
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const response = await projectState(c.env, ctx.project.id).fetch(
		new Request('http://internal/integrations/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'kaneo' }),
		}),
	);
	const data = (await response.json()) as { deleted: boolean; integration?: StoredIntegration };
	if (!data.deleted) {
		return c.json({ error: 'no_integration', message: 'Kaneo is not connected' }, 404);
	}
	await writeAudit(c.env, ctx.auth, 'integration.deleted', ctx.project, {
		integration: 'kaneo',
		kaneoProjectId: (data.integration?.config as KaneoConfig | undefined)?.kaneoProjectId,
	});
	return c.json({ deleted: true });
});
