/**
 * Slack integration (docs/plano-mcp-e-tenho-horario.md, "Fase 4"): posts a
 * message per issue to one channel — new issues that pass the filters,
 * errors that come back (thread reply) and resolutions (message edited).
 * Same rules as Kaneo (routes/integrations.ts): per project, owner/admin
 * only, and the only credential — the Slack app's bot token — is sealed with
 * INTEGRATIONS_KEY and only ever leaves this module masked.
 *
 *   GET    /api/projects/:slug/integrations/slack           config (masked) + app manifest
 *   POST   /api/projects/:slug/integrations/slack/discover  workspace, bot and channels
 *   PUT    /api/projects/:slug/integrations/slack           create or update
 *   POST   /api/projects/:slug/integrations/slack/test      post a test message
 *   DELETE /api/projects/:slug/integrations/slack           disconnect
 *   POST   /api/projects/:slug/issues/:issueId/links/slack  post the issue now (any member)
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { readCappedJson } from '../lib/capped-json';
import { type AppContext, getProjectWithAccess } from '../lib/project-access';
import { maskSecret, openSecret, SecretBoxError, sealSecret } from '../lib/secret-box';
import {
	checkBotToken,
	createSlackClient,
	SLACK_APP_SCOPES,
	type SlackChannel,
	type SlackClient,
	type SlackCredentials,
	SlackError,
	slackAppManifest,
} from '../lib/slack';
import { buildSlackTestMessage } from '../lib/slack-message';
import type { AuthContext, Env } from '../types';
import {
	badRequest,
	ISSUE_LEVELS,
	type IssueLevel,
	integrationContext,
	integrationsUnconfigured,
	loadIntegration,
	managedProject,
	parseEnvironments,
	projectState,
	type StoredIntegration,
	writeAudit,
} from './integrations';

type Ctx = AppContext;

export const slackIntegrationRoutes = new Hono<{
	Bindings: Env;
	Variables: { auth?: AuthContext };
}>();

const MAX_BODY_BYTES = 16 * 1024;
/** Slack channel ids: C… (public), G… (old private), D… is never accepted. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

/** What is stored in `integrations.config` for a Slack integration. */
export interface SlackConfig {
	teamId: string;
	teamName: string;
	botUserId: string;
	channelId: string;
	channelName: string;
	channelPrivate: boolean;
	minLevel: IssueLevel;
	environments: string[];
	notifyRegression: boolean;
	notifyResolved: boolean;
	sentinelProjectId?: string;
	sentinelProjectSlug?: string;
	sentinelProjectName?: string;
	sentinelOrigin?: string;
}

async function openSlackCredentials(
	env: Env,
	projectId: string,
	integration: StoredIntegration,
): Promise<SlackCredentials> {
	const plaintext = await openSecret(
		env.INTEGRATIONS_KEY as string,
		projectId,
		integration.secretCipher,
	);
	const { botToken } = JSON.parse(plaintext) as SlackCredentials;
	return { botToken };
}

/** Map a Slack failure to the response the caller sees. */
export function slackFailure(c: Ctx, error: unknown): Response {
	if (error instanceof SlackError) {
		const status: ContentfulStatusCode = error.code === 'invalid_token' ? 400 : 502;
		return c.json({ error: 'slack_failed', code: error.code, message: error.message }, status);
	}
	if (error instanceof SecretBoxError) {
		return c.json(
			{
				error: 'integration_secret_unreadable',
				message:
					'The stored Slack token could not be decrypted (was INTEGRATIONS_KEY changed?). Enter it again.',
			},
			409,
		);
	}
	throw error;
}

/** The integration as the dashboard and API see it: the token masked. */
export function slackView(integration: StoredIntegration, credentials: SlackCredentials | null) {
	const config = integration.config as unknown as SlackConfig;
	return {
		id: integration.id,
		type: 'slack' as const,
		enabled: integration.enabled,
		teamId: config.teamId,
		teamName: config.teamName,
		botUserId: config.botUserId,
		channelId: config.channelId,
		channelName: config.channelName,
		channelPrivate: config.channelPrivate === true,
		minLevel: config.minLevel,
		environments: config.environments ?? [],
		notifyRegression: config.notifyRegression !== false,
		notifyResolved: config.notifyResolved !== false,
		botToken: maskSecret(credentials?.botToken),
		credentialsReadable: credentials !== null,
		lastError: integration.lastError,
		lastErrorAt: integration.lastErrorAt,
		createdAt: integration.createdAt,
		updatedAt: integration.updatedAt,
	};
}

/**
 * The token typed in the form, or the stored one when it is left blank.
 * Returns a Response for anything the caller should answer with.
 */
async function resolveCredentials(
	c: Ctx,
	projectId: string,
	stored: StoredIntegration | null,
	rawToken: unknown,
): Promise<
	{ credentials: SlackCredentials; typed: boolean; stored: SlackCredentials | null } | Response
> {
	if (rawToken !== undefined && typeof rawToken !== 'string') {
		return badRequest(c, new Error('botToken must be a string'));
	}
	const typed = typeof rawToken === 'string' && rawToken.trim() !== '' ? rawToken.trim() : null;
	if (typed) {
		const checked = checkBotToken(typed);
		if (!checked.ok) return badRequest(c, new Error(checked.reason));
	}
	let storedCredentials: SlackCredentials | null = null;
	if (stored) {
		try {
			storedCredentials = await openSlackCredentials(c.env, projectId, stored);
		} catch (error) {
			// Unreadable (INTEGRATIONS_KEY rotated): typing the token again recovers it.
			if (!typed) return slackFailure(c, error);
		}
	}
	const botToken = typed ?? storedCredentials?.botToken;
	if (!botToken) return badRequest(c, new Error('botToken is required'));
	return { credentials: { botToken }, typed: typed !== null, stored: storedCredentials };
}

/** Find a channel by id or by name (`#errors` or `errors`). */
async function findChannel(
	client: SlackClient,
	requested: string,
): Promise<(SlackChannel & { isArchived: boolean }) | null> {
	const value = requested.trim().replace(/^#/, '');
	if (CHANNEL_ID.test(value)) {
		try {
			return await client.getChannel(value);
		} catch (error) {
			if (error instanceof SlackError && error.code === 'channel_not_found') return null;
			throw error;
		}
	}
	const name = value.toLowerCase();
	const { channels } = await client.listChannels();
	const match = channels.find((channel) => channel.name.toLowerCase() === name);
	return match ? { ...match, isArchived: false } : null;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined | Error {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') return new Error(`${field} must be true or false`);
	return value;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

slackIntegrationRoutes.get('/:slug/integrations/slack', async (c) => {
	const ctx = await managedProject(c, 'view integrations');
	if (ctx instanceof Response) return ctx;
	const configured = !integrationsUnconfigured(c);
	const setup = { scopes: SLACK_APP_SCOPES, manifest: slackAppManifest() };
	const integration = await loadIntegration(c.env, ctx.project.id, 'slack');
	if (!integration) return c.json({ configured, integration: null, ...setup });
	let credentials: SlackCredentials | null = null;
	if (configured) {
		try {
			credentials = await openSlackCredentials(c.env, ctx.project.id, integration);
		} catch {
			credentials = null;
		}
	}
	return c.json({ configured, integration: slackView(integration, credentials), ...setup });
});

/** What the given (or stored) token can see: the workspace, the bot and the channels. */
slackIntegrationRoutes.post('/:slug/integrations/slack/discover', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const parsed = await readCappedJson(c, MAX_BODY_BYTES);
	if (!parsed.ok) return parsed.response;

	const stored = await loadIntegration(c.env, ctx.project.id, 'slack');
	const resolved = await resolveCredentials(c, ctx.project.id, stored, parsed.body.botToken);
	if (resolved instanceof Response) return resolved;
	try {
		const client = createSlackClient(resolved.credentials);
		const identity = await client.authTest();
		const { channels, truncated } = await client.listChannels();
		return c.json({
			team: { id: identity.teamId, name: identity.teamName, url: identity.url },
			botUserId: identity.botUserId,
			channels,
			truncated,
		});
	} catch (error) {
		return slackFailure(c, error);
	}
});

slackIntegrationRoutes.put('/:slug/integrations/slack', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const parsed = await readCappedJson(c, MAX_BODY_BYTES);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const stored = await loadIntegration(c.env, ctx.project.id, 'slack');
	const storedConfig = stored ? (stored.config as unknown as SlackConfig) : null;
	const resolved = await resolveCredentials(c, ctx.project.id, stored, body.botToken);
	if (resolved instanceof Response) return resolved;
	const { credentials } = resolved;

	// `channel` takes an id or a name (the MCP passes names); `channelId` is the form's.
	const rawChannel = body.channelId ?? body.channel;
	if (rawChannel !== undefined && (typeof rawChannel !== 'string' || rawChannel.length > 128)) {
		return badRequest(c, new Error('channel must be a Slack channel id or name'));
	}
	const requestedChannel =
		typeof rawChannel === 'string' && rawChannel.trim() !== ''
			? rawChannel
			: storedConfig?.channelId;
	if (!requestedChannel) return badRequest(c, new Error('channel is required'));

	const minLevel = body.minLevel ?? storedConfig?.minLevel ?? 'error';
	if (!ISSUE_LEVELS.includes(minLevel as IssueLevel)) {
		return badRequest(c, new Error(`minLevel must be one of ${ISSUE_LEVELS.join(', ')}`));
	}
	const environments = parseEnvironments(body.environments, storedConfig?.environments ?? []);
	if (environments instanceof Error) return badRequest(c, environments);
	const flags: Record<'enabled' | 'notifyRegression' | 'notifyResolved', boolean | undefined> = {
		enabled: undefined,
		notifyRegression: undefined,
		notifyResolved: undefined,
	};
	for (const field of Object.keys(flags) as (keyof typeof flags)[]) {
		const value = optionalBoolean(body[field], field);
		if (value instanceof Error) return badRequest(c, value);
		flags[field] = value;
	}

	// Validate against Slack itself before storing anything.
	let identity: Awaited<ReturnType<SlackClient['authTest']>>;
	let channel: Awaited<ReturnType<typeof findChannel>>;
	try {
		const client = createSlackClient(credentials);
		identity = await client.authTest();
		channel = await findChannel(client, requestedChannel);
	} catch (error) {
		return slackFailure(c, error);
	}
	if (!channel) {
		return badRequest(
			c,
			new Error(
				`Slack channel "${requestedChannel}" not found (private channels need the bot invited first)`,
			),
		);
	}
	if (channel.isArchived) return badRequest(c, new Error(`#${channel.name} is archived`));
	if (channel.isPrivate && !channel.isMember) {
		return badRequest(
			c,
			new Error(`The bot is not in #${channel.name}: invite it with /invite @<bot name>`),
		);
	}

	const context = integrationContext(c, ctx.project);
	const config: SlackConfig = {
		teamId: identity.teamId,
		teamName: identity.teamName,
		botUserId: identity.botUserId,
		channelId: channel.id,
		channelName: channel.name,
		channelPrivate: channel.isPrivate,
		minLevel: minLevel as IssueLevel,
		environments,
		notifyRegression: flags.notifyRegression ?? storedConfig?.notifyRegression ?? true,
		notifyResolved: flags.notifyResolved ?? storedConfig?.notifyResolved ?? true,
		sentinelProjectId: context.projectId,
		sentinelProjectSlug: context.slug,
		sentinelProjectName: context.name,
		sentinelOrigin: context.origin,
	};

	const tokenChanged = !resolved.stored || resolved.stored.botToken !== credentials.botToken;
	// A token from another workspace cannot edit the old messages: forget them.
	const workspaceChanged = Boolean(storedConfig?.teamId && storedConfig.teamId !== identity.teamId);
	const secretCipher = tokenChanged
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
				type: 'slack',
				enabled: flags.enabled ?? stored?.enabled ?? true,
				config,
				secretCipher,
				resetLinks: workspaceChanged,
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
		? (Object.keys(config) as (keyof SlackConfig)[]).filter(
				(key) => JSON.stringify(config[key]) !== JSON.stringify(storedConfig[key]),
			)
		: undefined;
	await writeAudit(
		c.env,
		ctx.auth,
		saved.created ? 'integration.created' : 'integration.updated',
		ctx.project,
		{
			integration: 'slack',
			channel: config.channelId,
			...(changedFields ? { fields: changedFields } : {}),
			...(workspaceChanged ? { workspaceChanged: true } : {}),
		},
	);
	if (tokenChanged && !saved.created) {
		await writeAudit(c.env, ctx.auth, 'integration.key_changed', ctx.project, {
			integration: 'slack',
		});
	}

	return c.json(
		{ integration: slackView(saved.integration, credentials) },
		saved.created ? 201 : 200,
	);
});

/** Post a test message to the configured channel. */
slackIntegrationRoutes.post('/:slug/integrations/slack/test', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const integration = await loadIntegration(c.env, ctx.project.id, 'slack');
	if (!integration) {
		return c.json({ error: 'no_integration', message: 'Slack is not connected' }, 404);
	}
	const config = integration.config as unknown as SlackConfig;
	const origin = new URL(c.req.url).origin;
	try {
		const credentials = await openSlackCredentials(c.env, ctx.project.id, integration);
		const client = createSlackClient(credentials);
		await client.postMessage(
			config.channelId,
			buildSlackTestMessage(
				ctx.project.name,
				`${origin}/projects/${encodeURIComponent(ctx.project.slug)}/settings#slack`,
			),
		);
		return c.json({ ok: true, channel: { id: config.channelId, name: config.channelName } });
	} catch (error) {
		return slackFailure(c, error);
	}
});

slackIntegrationRoutes.delete('/:slug/integrations/slack', async (c) => {
	const ctx = await managedProject(c, 'configure integrations');
	if (ctx instanceof Response) return ctx;
	const response = await projectState(c.env, ctx.project.id).fetch(
		new Request('http://internal/integrations/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'slack' }),
		}),
	);
	const data = (await response.json()) as { deleted: boolean; integration?: StoredIntegration };
	if (!data.deleted) {
		return c.json({ error: 'no_integration', message: 'Slack is not connected' }, 404);
	}
	await writeAudit(c.env, ctx.auth, 'integration.deleted', ctx.project, {
		integration: 'slack',
		channel: (data.integration?.config as SlackConfig | undefined)?.channelId,
	});
	return c.json({ deleted: true });
});

/**
 * Post the issue's Slack message now (the "Post to Slack" button), for issues
 * the filters left out. Any project member, like other triage. Idempotent:
 * an issue that already has a message answers 200 with it.
 */
slackIntegrationRoutes.post('/:slug/issues/:issueId/links/slack', async (c) => {
	const unconfigured = integrationsUnconfigured(c);
	if (unconfigured) return unconfigured;
	const access = await getProjectWithAccess(c, c.req.param('slug'));
	if (access instanceof Response) return access;
	const response = await projectState(c.env, access.project.id).fetch(
		new Request('http://internal/integrations/create-task', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'slack',
				issueId: c.req.param('issueId').toLowerCase(),
				context: integrationContext(c, access.project),
			}),
		}),
	);
	return c.json(await response.json(), response.status as ContentfulStatusCode);
});
