/**
 * Sentinel MCP tools. Every tool acts through the worker's own routes via
 * `ctx.callApi`, with the MCP caller's credential — so authMiddleware, the
 * token scopes and the per-project role checks apply exactly as they do for
 * the dashboard and the API. Nothing here re-implements a permission rule;
 * the only gate of its own is visibility (`scope`/`adminOnly`), which hides
 * tools the token could never use.
 */
import { debugFileGuide, TOKEN_ENV } from '../lib/debug-file-guide';
import { summarizeEvent } from '../lib/event-summary';
import { getPlatform, PLATFORMS, type PlatformId, platformForProject } from '../lib/platforms';
import { hasScope } from '../lib/token-scopes';
import type { ApiTokenScope, AuthContext } from '../types';

export interface ApiResult {
	status: number;
	data: unknown;
}

export interface ToolContext {
	auth: AuthContext;
	/** Origin the MCP request reached (dashboard links, DSN host). */
	origin: string;
	/** Calls a protected route (`/api/…`) with the caller's credential. */
	callApi(method: string, path: string, body?: unknown): Promise<ApiResult>;
	/** Like callApi, but sends `body` as raw bytes (debug-file uploads). */
	callApiRaw(
		method: string,
		path: string,
		body: Uint8Array,
		headers?: Record<string, string>,
	): Promise<ApiResult>;
	/** Unauthenticated request into the worker (SDK ingestion by DSN). */
	fetchInternal(path: string, init: RequestInit): Promise<Response>;
}

type JsonSchema = {
	type: 'object';
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
	additionalProperties: false;
};

export interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

interface Tool {
	definition: {
		name: string;
		title: string;
		description: string;
		inputSchema: JsonSchema;
		annotations: {
			title: string;
			readOnlyHint: boolean;
			destructiveHint: boolean;
			idempotentHint: boolean;
			openWorldHint: boolean;
		};
	};
	/** Least scope a token needs for the tool to be listed. */
	scope: ApiTokenScope;
	/** Only listed for instance admins (project creation). */
	adminOnly?: boolean;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export function toolText(text: string): ToolResult {
	return { content: [{ type: 'text', text }] };
}

export function toolJson(value: unknown): ToolResult {
	return toolText(JSON.stringify(value, null, 2));
}

export function toolError(text: string): ToolResult {
	return { content: [{ type: 'text', text }], isError: true };
}

/** Turns a non-2xx API answer into a message the agent can relay. */
function apiError(result: ApiResult, what: string): ToolResult {
	const data = (result.data ?? {}) as {
		error?: string;
		message?: string;
		detail?: string;
		required?: string;
	};
	const message = data.message ?? data.detail;
	if (result.status === 401)
		return toolError(`Not authenticated: ${message ?? 'invalid or expired credential'}.`);
	if (result.status === 403 && data.error === 'insufficient_scope') {
		return toolError(
			`Permission denied (${what}): this token lacks the "${data.required}" scope. A token with more access must be created in the Sentinel dashboard (API tokens).`,
		);
	}
	if (result.status === 403) {
		return toolError(`Permission denied (${what}): ${message ?? data.error ?? 'forbidden'}.`);
	}
	if (result.status === 404) {
		return toolError(
			`Not found (${what}): it does not exist, or the user is not a member of the project. list_projects shows the projects this user can reach.`,
		);
	}
	return toolError(
		`Sentinel answered ${result.status} (${what}): ${message ?? data.error ?? 'unexpected error'}.`,
	);
}

const ok = (r: ApiResult) => r.status >= 200 && r.status < 300;

/** Slack failures carry an actionable message; a missing integration points at the settings. */
function slackToolError(
	ctx: ToolContext,
	result: ApiResult,
	slug: string,
	what: string,
): ToolResult {
	const data = (result.data ?? {}) as { error?: string; message?: string };
	if (data.error === 'no_integration') {
		return toolError(
			`Slack is not connected to "${slug}": the user connects it at ${ctx.origin}/projects/${encodeURIComponent(slug)}/integrations/slack.`,
		);
	}
	if (data.error === 'integration_incomplete') {
		return toolError(
			`Slack on "${slug}" has a saved bot token but no channel yet: call configure_slack with a channel first.`,
		);
	}
	if (data.error === 'slack_failed' || data.error === 'invalid_integration') {
		return toolError(`Slack refused (${what}): ${data.message ?? data.error}.`);
	}
	return apiError(result, what);
}

// ---------------------------------------------------------------------------
// Argument validation (the subset of JSON Schema the tools use)
// ---------------------------------------------------------------------------

export function validateArgs(schema: JsonSchema, args: unknown): string | null {
	if (args === null || typeof args !== 'object' || Array.isArray(args))
		return 'arguments must be an object';
	const record = args as Record<string, unknown>;
	for (const key of schema.required ?? []) {
		if (record[key] === undefined || record[key] === null || record[key] === '')
			return `"${key}" is required`;
	}
	for (const [key, value] of Object.entries(record)) {
		const prop = schema.properties[key];
		if (!prop) return `unknown argument "${key}"`;
		if (value === undefined || value === null) continue;
		const type = prop.type;
		if (type === 'string') {
			if (typeof value !== 'string') return `"${key}" must be a string`;
			if (typeof prop.maxLength === 'number' && value.length > prop.maxLength) {
				return `"${key}" must be at most ${prop.maxLength} characters`;
			}
		}
		if (type === 'integer' && !Number.isInteger(value)) return `"${key}" must be an integer`;
		if (type === 'integer' || type === 'number') {
			if (typeof value !== 'number') return `"${key}" must be a number`;
			if (typeof prop.minimum === 'number' && value < prop.minimum)
				return `"${key}" must be ≥ ${prop.minimum}`;
			if (typeof prop.maximum === 'number' && value > prop.maximum)
				return `"${key}" must be ≤ ${prop.maximum}`;
		}
		if (type === 'boolean' && typeof value !== 'boolean') return `"${key}" must be true or false`;
		if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
			return `"${key}" must be one of: ${prop.enum.join(', ')}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ProjectRole = 'owner' | 'admin' | 'member';

interface ApiProject {
	id: string;
	name: string;
	slug: string;
	platform: string;
	publicKey: string;
	ingestId?: number | null;
	createdAt: string;
	memberRole?: ProjectRole;
}

/** What this user may do in a project, given their role and the token's scopes. */
function capabilities(auth: AuthContext, role: ProjectRole | undefined) {
	const manager = role === 'owner' || role === 'admin';
	const write = hasScope(auth, 'write');
	const projects = hasScope(auth, 'projects');
	return {
		read: true,
		triageIssues: write,
		comment: write,
		uploadSourceMaps: write,
		uploadDebugFiles: write,
		deleteDebugFiles: write && manager,
		editSettings: write && manager,
		deleteIssues: write && manager,
		rotateDsnKey: projects && manager,
		deleteProject: projects && role === 'owner',
	};
}

const enc = encodeURIComponent;

function dashboardLink(ctx: ToolContext, path: string): string {
	return `${ctx.origin}${path}`;
}

async function loadProject(
	ctx: ToolContext,
	slug: string,
): Promise<{ project: ApiProject; role: ProjectRole | undefined; dsn: string } | ToolResult> {
	const result = await ctx.callApi('GET', `/api/projects/${enc(slug)}`);
	if (!ok(result)) return apiError(result, `project "${slug}"`);
	const data = result.data as { project: ApiProject; memberRole?: ProjectRole; dsn: string };
	return { project: data.project, role: data.memberRole, dsn: data.dsn };
}

const isToolResult = (value: unknown): value is ToolResult =>
	!!value && typeof value === 'object' && 'content' in value;

function renderGuide(
	platformId: PlatformId,
	project: { name: string; slug: string },
	dsn: string,
): string {
	const guide = getPlatform(platformId);
	const lines = [
		`# Send errors from ${guide.name} to the Sentinel project "${project.name}" (${project.slug})`,
		'',
		guide.summary,
		'',
		`DSN: ${dsn}`,
		'(The DSN is public by design: it can only send events. Never put an API token in an app.)',
		'',
		`Support: ${guide.support === 'verified' ? `tested with Sentinel (${guide.verifiedBy})` : 'Sentry protocol — expected to work, not run against Sentinel yet'}`,
		'',
		'## Steps',
	];
	guide.steps({ dsn, project: project.slug }).forEach((step, i) => {
		lines.push('', `${i + 1}. ${step.title}`);
		if (step.description) lines.push(`   ${step.description}`);
		lines.push('', '```' + step.language, step.code, '```');
	});
	if (guide.notes.length > 0) {
		lines.push('', '## Notes', ...guide.notes.map((n) => `- ${n}`));
	}
	lines.push(
		'',
		'## Verify',
		`- Call send_test_event with project "${project.slug}" to check the project receives events.`,
		'- Then trigger a real error in the app and look for it with list_issues.',
	);
	return lines.join('\n');
}

const PROJECT_ARG = {
	type: 'string',
	description: 'Project slug (list_projects shows them).',
	maxLength: 200,
};
const ISSUE_ARG = { type: 'string', description: 'Issue id (from list_issues).', maxLength: 64 };
const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
/** Largest file `upload_debug_file` takes inline (base64 inflates the request by a third). */
const MCP_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

function readOnly(title: string) {
	return {
		title,
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	};
}
function writes(
	title: string,
	opts: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {},
) {
	return {
		title,
		readOnlyHint: false,
		destructiveHint: opts.destructive ?? false,
		idempotentHint: opts.idempotent ?? false,
		openWorldHint: opts.openWorld ?? false,
	};
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
	{
		scope: 'read',
		definition: {
			name: 'whoami',
			title: 'Who am I',
			description:
				"The user this MCP acts as: instance role, the credential (token scopes and expiry — null means it never expires) and every project with the user's role and allowed actions. Call it first.",
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: readOnly('Who am I'),
		},
		async run(_args, ctx) {
			const list = await ctx.callApi('GET', '/api/projects');
			if (!ok(list)) return apiError(list, 'projects');
			const { auth } = ctx;
			const projects = ((list.data as { projects: ApiProject[] }).projects ?? []).map((p) => ({
				slug: p.slug,
				name: p.name,
				role: p.memberRole,
				can: capabilities(auth, p.memberRole),
			}));
			return toolJson({
				user: {
					id: auth.user.id,
					name: auth.user.name,
					email: auth.user.email,
					instanceRole: auth.user.role,
				},
				credential: auth.apiToken
					? {
							type: 'api_token',
							prefix: auth.apiToken.prefix,
							scopes: auth.apiToken.scopes,
							expiresAt: auth.apiToken.expiresAt,
							neverExpires: auth.apiToken.expiresAt === null,
						}
					: { type: 'session', signedInWith: auth.session.authMethod ?? 'password' },
				canCreateProjects:
					auth.user.role === 'admin' &&
					(auth.apiToken ? hasScope(auth, 'projects') : auth.session.authMethod === 'passkey'),
				projects,
				neverAvailableHere:
					'Users, project membership, ownership, instance settings and the audit log are managed only in the Sentinel dashboard (admin area).',
			});
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'list_projects',
			title: 'List projects',
			description:
				"Projects the user is a member of, with their platform, the user's role and allowed actions.",
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: readOnly('List projects'),
		},
		async run(_args, ctx) {
			const list = await ctx.callApi('GET', '/api/projects');
			if (!ok(list)) return apiError(list, 'projects');
			const projects = ((list.data as { projects: ApiProject[] }).projects ?? []).map((p) => ({
				slug: p.slug,
				name: p.name,
				platform: p.platform,
				setupGuide: platformForProject(p.platform),
				role: p.memberRole,
				can: capabilities(ctx.auth, p.memberRole),
				dashboard: dashboardLink(ctx, `/projects/${p.slug}/issues`),
			}));
			return toolJson({ projects });
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'get_project',
			title: 'Get a project',
			description:
				'One project: DSN, platform, the user\'s role, allowed actions ("can") and, for owners/admins, its settings (rate limit, retention, scrubbed headers).',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('Get a project'),
		},
		async run(args, ctx) {
			const loaded = await loadProject(ctx, args.project as string);
			if (isToolResult(loaded)) return loaded;
			const { project, role, dsn } = loaded;
			const can = capabilities(ctx.auth, role);
			let settings: unknown;
			if (can.editSettings) {
				const result = await ctx.callApi('GET', `/api/projects/${enc(project.slug)}/settings`);
				if (ok(result)) settings = result.data;
			}
			return toolJson({
				slug: project.slug,
				name: project.name,
				platform: project.platform,
				setupGuide: platformForProject(project.platform),
				dsn,
				role,
				can,
				settings,
				createdAt: project.createdAt,
				dashboard: dashboardLink(ctx, `/projects/${project.slug}/issues`),
			});
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'list_platforms',
			title: 'List platforms',
			description:
				'Platforms Sentinel has setup guides for (Browser, Node.js, Cloudflare Workers incl. Hono, Astro, Deno, Bun, Python, PHP, iOS, Android, "envelope" for no SDK, other). Use the id with create_project and get_setup_guide.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: readOnly('List platforms'),
		},
		async run() {
			return toolJson({
				platforms: PLATFORMS.map((p) => ({
					id: p.id,
					name: p.name,
					summary: p.summary,
					support: p.support,
					projectPlatform: p.projectPlatform,
				})),
			});
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'get_setup_guide',
			title: 'Get a setup guide',
			description:
				"Step-by-step instructions, with the project's DSN filled in, to send errors from an app to this project. Defaults to the project's platform.",
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					platform: {
						type: 'string',
						enum: PLATFORM_IDS,
						description: 'Platform id (list_platforms).',
					},
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('Get a setup guide'),
		},
		async run(args, ctx) {
			const loaded = await loadProject(ctx, args.project as string);
			if (isToolResult(loaded)) return loaded;
			const platform =
				(args.platform as PlatformId | undefined) ?? platformForProject(loaded.project.platform);
			return toolText(renderGuide(platform, loaded.project, loaded.dsn));
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'list_issues',
			title: 'List issues',
			description: 'Issues of a project, newest activity first.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					status: {
						type: 'string',
						enum: ['unresolved', 'resolved', 'ignored'],
						description: 'Default: unresolved.',
					},
					environment: { type: 'string', maxLength: 200, description: 'e.g. production, staging.' },
					query: { type: 'string', maxLength: 500, description: 'Text search in titles.' },
					level: { type: 'string', enum: ['fatal', 'error', 'warning', 'info', 'debug'] },
					sort: {
						type: 'string',
						enum: ['last_seen', 'first_seen', 'count', 'user_count'],
						description: 'Default: last_seen.',
					},
					limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25.' },
					cursor: {
						type: 'string',
						maxLength: 500,
						description: 'nextCursor from a previous call.',
					},
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('List issues'),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const params = new URLSearchParams({
				status: (args.status as string) ?? 'unresolved',
				limit: String(args.limit ?? 25),
			});
			for (const key of ['environment', 'query', 'level', 'sort', 'cursor'] as const) {
				if (typeof args[key] === 'string') params.set(key, args[key] as string);
			}
			const result = await ctx.callApi('GET', `/api/projects/${enc(slug)}/issues?${params}`);
			if (!ok(result)) return apiError(result, `issues of "${slug}"`);
			const data = result.data as { issues: Array<Record<string, unknown>>; nextCursor?: string };
			return toolJson({
				issues: data.issues.map((i) => ({
					id: i.id,
					title: i.title,
					culprit: i.culprit,
					level: i.level,
					status: i.status,
					count: i.count,
					userCount: i.userCount,
					firstSeen: i.firstSeen,
					lastSeen: i.lastSeen,
					dashboard: dashboardLink(ctx, `/projects/${slug}/issues/${i.id}`),
				})),
				nextCursor: data.nextCursor,
			});
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'get_issue',
			title: 'Get an issue',
			description:
				'One issue with its latest event summarized: exception type and message, stack frames (innermost first, app frames marked [app]), tags, environment, release and the last breadcrumbs; plus the Kaneo task and Slack message linked to it.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG, issue_id: ISSUE_ARG },
				required: ['project', 'issue_id'],
				additionalProperties: false,
			},
			annotations: readOnly('Get an issue'),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const issueId = args.issue_id as string;
			const detail = await ctx.callApi('GET', `/api/projects/${enc(slug)}/issues/${enc(issueId)}`);
			if (!ok(detail)) return apiError(detail, `issue ${issueId}`);
			const events = await ctx.callApi(
				'GET',
				`/api/projects/${enc(slug)}/issues/${enc(issueId)}/events?limit=1`,
			);
			const latest = ok(events)
				? (events.data as { events?: Array<Record<string, unknown>> }).events?.[0]
				: undefined;
			const data = detail.data as { issue?: Record<string, unknown> } & Record<string, unknown>;
			return toolJson({
				issue: data.issue ?? data,
				/** Kaneo tasks and Slack messages linked to the issue. */
				links: Array.isArray(data.links) ? data.links : [],
				latestEvent: latest ? summarizeEvent(latest) : null,
				dashboard: dashboardLink(ctx, `/projects/${slug}/issues/${issueId}`),
			});
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'get_event',
			title: 'Get an event',
			description:
				'The full stored event JSON (as the SDK sent it, after scrubbing). Large: prefer get_issue.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG, event_id: { type: 'string', maxLength: 64 } },
				required: ['project', 'event_id'],
				additionalProperties: false,
			},
			annotations: readOnly('Get an event'),
		},
		async run(args, ctx) {
			const result = await ctx.callApi(
				'GET',
				`/api/projects/${enc(args.project as string)}/events/${enc(args.event_id as string)}`,
			);
			if (!ok(result)) return apiError(result, `event ${args.event_id}`);
			const text = JSON.stringify(result.data, null, 2);
			const MAX = 60_000;
			return toolText(
				text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated at ${MAX} characters)` : text,
			);
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'list_releases',
			title: 'List releases',
			description: 'Releases seen in a project, newest first.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('List releases'),
		},
		async run(args, ctx) {
			const result = await ctx.callApi(
				'GET',
				`/api/projects/${enc(args.project as string)}/releases`,
			);
			if (!ok(result)) return apiError(result, `releases of "${args.project}"`);
			return toolJson(result.data);
		},
	},

	// --- write ------------------------------------------------------------
	{
		scope: 'write',
		definition: {
			name: 'update_issue',
			title: 'Update an issue',
			description: 'Resolve, ignore or reopen an issue. Any project member may.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					issue_id: ISSUE_ARG,
					status: { type: 'string', enum: ['resolved', 'unresolved', 'ignored'] },
				},
				required: ['project', 'issue_id', 'status'],
				additionalProperties: false,
			},
			annotations: writes('Update an issue', { idempotent: true }),
		},
		async run(args, ctx) {
			const result = await ctx.callApi(
				'PATCH',
				`/api/projects/${enc(args.project as string)}/issues/${enc(args.issue_id as string)}`,
				{ status: args.status },
			);
			if (!ok(result)) return apiError(result, `updating issue ${args.issue_id}`);
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'add_issue_note',
			title: 'Add a note to an issue',
			description: 'Comment on an issue (Markdown). Shown in the issue activity in the dashboard.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					issue_id: ISSUE_ARG,
					text: { type: 'string', maxLength: 10000 },
				},
				required: ['project', 'issue_id', 'text'],
				additionalProperties: false,
			},
			annotations: writes('Add a note to an issue'),
		},
		async run(args, ctx) {
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(args.project as string)}/issues/${enc(args.issue_id as string)}/comments`,
				{ body: args.text },
			);
			if (!ok(result)) return apiError(result, `commenting on issue ${args.issue_id}`);
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'create_kaneo_task',
			title: 'Create a Kaneo task for an issue',
			description:
				"Creates the issue's task on the project's Kaneo board (title, level, where, release, counts, the exception and a link back to the issue; no user data) and links the two: closing the task in Kaneo then resolves the issue. Idempotent: an issue that already has a task returns it (created: false). Any project member; Kaneo must be connected in the project settings. Ask the user before calling.",
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG, issue_id: ISSUE_ARG },
				required: ['project', 'issue_id'],
				additionalProperties: false,
			},
			annotations: writes('Create a Kaneo task for an issue', {
				idempotent: true,
				openWorld: true,
			}),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(slug)}/issues/${enc(args.issue_id as string)}/links/kaneo`,
			);
			if (!ok(result)) {
				const data = (result.data ?? {}) as { error?: string; message?: string };
				if (data.error === 'no_integration') {
					return toolError(
						`Kaneo is not connected to "${slug}": an owner or admin connects it at ${dashboardLink(ctx, `/projects/${enc(slug)}/integrations/kaneo`)}.`,
					);
				}
				if (data.error === 'kaneo_failed' || data.error === 'integration_secret_unreadable') {
					return toolError(`Kaneo refused (creating the task): ${data.message ?? data.error}.`);
				}
				return apiError(result, `creating the Kaneo task of issue ${args.issue_id}`);
			}
			const data = result.data as { link?: unknown; created?: boolean };
			return toolJson({ created: data.created === true, link: data.link ?? null });
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'update_project',
			title: 'Update a project',
			description:
				"Change a project's name, platform, webhook URL (Slack/Discord/any https endpoint; null removes it), hourly event limit or retention. Project owners and admins only.",
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					name: { type: 'string', maxLength: 200 },
					platform: {
						type: 'string',
						maxLength: 64,
						description: 'A platform id or Sentry platform slug.',
					},
					webhook_url: {
						type: 'string',
						maxLength: 2000,
						description: 'https URL; empty string removes it.',
					},
					max_events_per_hour: { type: 'integer', minimum: 0, maximum: 1000000 },
					retention_days: { type: 'integer', minimum: 0, maximum: 3650 },
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: writes('Update a project', { idempotent: true }),
		},
		async run(args, ctx) {
			const body: Record<string, unknown> = {};
			if (args.name !== undefined) body.name = args.name;
			if (args.platform !== undefined) body.platform = args.platform;
			if (args.webhook_url !== undefined)
				body.webhookUrl = args.webhook_url === '' ? null : args.webhook_url;
			if (args.max_events_per_hour !== undefined) body.maxEventsPerHour = args.max_events_per_hour;
			if (args.retention_days !== undefined) body.retentionDays = args.retention_days;
			if (Object.keys(body).length === 0)
				return toolError('Nothing to change: pass at least one field.');
			const slug = args.project as string;
			const result = await ctx.callApi('PATCH', `/api/projects/${enc(slug)}`, body);
			if (!ok(result)) return apiError(result, `updating project "${slug}"`);
			return toolJson({ updated: Object.keys(body), result: result.data });
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'send_test_event',
			title: 'Send a test event',
			description:
				'Sends one test event to the project through its DSN, exactly like an SDK, and confirms it was stored. Use it to check a newly connected project.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					message: {
						type: 'string',
						maxLength: 500,
						description: 'Default: "Sentinel test event".',
					},
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: writes('Send a test event'),
		},
		async run(args, ctx) {
			const loaded = await loadProject(ctx, args.project as string);
			if (isToolResult(loaded)) return loaded;
			const { project, dsn } = loaded;
			const eventId = crypto.randomUUID().replace(/-/g, '');
			const event = {
				event_id: eventId,
				timestamp: Date.now() / 1000,
				platform: 'other',
				level: 'info',
				logger: 'sentinel.mcp',
				message: { formatted: (args.message as string | undefined) ?? 'Sentinel test event' },
				tags: { sentinel_test: 'true', source: 'mcp' },
			};
			const body = `${JSON.stringify({ event_id: eventId, dsn, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
			const ingestId = project.ingestId ?? project.id;
			const response = await ctx.fetchInternal(`/api/${ingestId}/envelope/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-sentry-envelope' },
				body,
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				return toolError(
					`The project refused the test event (${response.status}): ${detail.slice(0, 300)}`,
				);
			}
			const stored = await ctx.callApi(
				'GET',
				`/api/projects/${enc(project.slug)}/events/${eventId}`,
			);
			return toolJson({
				sent: true,
				stored: ok(stored),
				eventId,
				note: ok(stored)
					? 'The project receives events. It shows up as an issue named after the message.'
					: 'Accepted by ingestion but not readable yet — inbound filters or the hourly limit may have dropped it.',
				dashboard: dashboardLink(ctx, `/projects/${project.slug}/issues`),
			});
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'test_webhook',
			title: 'Test the webhook',
			description:
				"Sends a test notification to the project's webhook and reports the answer. Owners and admins.",
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: writes('Test the webhook', { openWorld: true }),
		},
		async run(args, ctx) {
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(args.project as string)}/test-webhook`,
			);
			if (!ok(result)) return apiError(result, `testing the webhook of "${args.project}"`);
			return toolJson(result.data);
		},
	},

	// --- integrations -------------------------------------------------------
	{
		scope: 'read',
		definition: {
			name: 'get_integrations',
			title: 'Get the integrations',
			description:
				'The project\'s integrations (Kaneo, Slack): what is connected (status "connected", or "pending" when the credentials are saved but no project/channel is chosen yet), its filters, the last delivery error and the Integrations page. Secrets come back masked. Owners and admins.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('Get the integrations'),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const [kaneo, slack] = await Promise.all([
				ctx.callApi('GET', `/api/projects/${enc(slug)}/integrations/kaneo`),
				ctx.callApi('GET', `/api/projects/${enc(slug)}/integrations/slack`),
			]);
			if (!ok(kaneo)) return apiError(kaneo, `the integrations of "${slug}"`);
			if (!ok(slack)) return apiError(slack, `the integrations of "${slug}"`);
			const kaneoData = kaneo.data as { configured: boolean; integration: unknown };
			const slackData = slack.data as { integration: unknown };
			return toolJson({
				integrationsAvailable: kaneoData.configured,
				kaneo: kaneoData.integration,
				slack: slackData.integration,
				settings: dashboardLink(ctx, `/projects/${enc(slug)}/integrations`),
			});
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'list_slack_channels',
			title: 'List Slack channels',
			description:
				'Slack channels the connected Slack app can post to (public channels, and private ones the bot was invited to). Uses the token stored in the project settings. Owners and admins.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('List Slack channels'),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(slug)}/integrations/slack/discover`,
				{},
			);
			if (!ok(result)) return slackToolError(ctx, result, slug, 'listing the Slack channels');
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'configure_slack',
			title: 'Configure Slack',
			description:
				'Points the project\'s Slack integration at a channel and sets its filters: a message per new issue at or above min_level (in the given environments, when set), a thread reply when a resolved issue comes back, and the message marked resolved when the issue is resolved. The Slack bot token is never passed here: if none is stored yet, the user pastes it on the integration page this tool links to. A saved token without a channel shows as status "pending" in get_integrations; this tool then only needs the channel. Ask the user before calling. Owners and admins.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					channel: {
						type: 'string',
						maxLength: 128,
						description:
							'Channel name (#errors or errors) or id. Optional once configured (keeps the current one).',
					},
					min_level: {
						type: 'string',
						enum: ['debug', 'info', 'warning', 'error', 'fatal'],
						description: 'Lowest level that posts a message. Default: error.',
					},
					environments: {
						type: 'array',
						items: { type: 'string', maxLength: 64 },
						description: 'Only these environments (empty list: all).',
					},
					notify_regression: {
						type: 'boolean',
						description: 'Reply when a resolved issue comes back. Default: true.',
					},
					notify_resolved: {
						type: 'boolean',
						description: 'Mark the message resolved when the issue is resolved. Default: true.',
					},
					enabled: { type: 'boolean', description: 'Pause (false) or resume (true) deliveries.' },
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: writes('Configure Slack', { idempotent: true, openWorld: true }),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const current = await ctx.callApi('GET', `/api/projects/${enc(slug)}/integrations/slack`);
			if (!ok(current)) return apiError(current, `the Slack integration of "${slug}"`);
			if (!(current.data as { integration: unknown }).integration) {
				return toolError(
					`Slack is not connected to "${slug}" yet. The bot token is only entered in the dashboard: ask the user to open ${dashboardLink(ctx, `/projects/${enc(slug)}/integrations/slack`)}, follow the steps there (create the Slack app, install it, paste its Bot User OAuth Token and Verify & save). Then call configure_slack again.`,
				);
			}
			if (args.environments !== undefined && !Array.isArray(args.environments)) {
				return toolError('"environments" must be a list of names');
			}
			const body: Record<string, unknown> = {};
			if (args.channel) body.channel = args.channel;
			if (args.min_level) body.minLevel = args.min_level;
			if (args.environments !== undefined) body.environments = args.environments;
			if (args.notify_regression !== undefined) body.notifyRegression = args.notify_regression;
			if (args.notify_resolved !== undefined) body.notifyResolved = args.notify_resolved;
			if (args.enabled !== undefined) body.enabled = args.enabled;
			const result = await ctx.callApi(
				'PUT',
				`/api/projects/${enc(slug)}/integrations/slack`,
				body,
			);
			if (!ok(result)) return slackToolError(ctx, result, slug, 'configuring Slack');
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'test_slack',
			title: 'Test Slack',
			description:
				"Posts a test message to the project's Slack channel and reports the answer. Owners and admins.",
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: writes('Test Slack', { openWorld: true }),
		},
		async run(args, ctx) {
			const slug = args.project as string;
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(slug)}/integrations/slack/test`,
			);
			if (!ok(result)) return slackToolError(ctx, result, slug, 'testing Slack');
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'disconnect_slack',
			title: 'Disconnect Slack',
			description:
				'Removes the Slack integration: the stored token, the links to posted messages and pending deliveries. Messages already in Slack stay. Owners and admins; needs "confirm" = the project slug.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					confirm: { type: 'string', maxLength: 200, description: 'Repeat the project slug.' },
				},
				required: ['project', 'confirm'],
				additionalProperties: false,
			},
			annotations: writes('Disconnect Slack', { destructive: true, idempotent: true }),
		},
		async run(args, ctx) {
			if (args.confirm !== args.project) {
				return toolError(
					`Not disconnected: "confirm" must be exactly the project slug ("${args.project}").`,
				);
			}
			const slug = args.project as string;
			const result = await ctx.callApi('DELETE', `/api/projects/${enc(slug)}/integrations/slack`);
			if (!ok(result)) return slackToolError(ctx, result, slug, 'disconnecting Slack');
			return toolJson({ disconnected: true, project: slug });
		},
	},

	// --- projects -----------------------------------------------------------
	{
		scope: 'projects',
		adminOnly: true,
		definition: {
			name: 'create_project',
			title: 'Create a project',
			description:
				'Creates a project owned by the user and returns its DSN and setup guide. Instance admins only, with a token that has the "projects" scope.',
			inputSchema: {
				type: 'object',
				properties: {
					name: { type: 'string', maxLength: 200 },
					platform: {
						type: 'string',
						enum: PLATFORM_IDS,
						description: 'Platform id (list_platforms). Default: browser.',
					},
				},
				required: ['name'],
				additionalProperties: false,
			},
			annotations: writes('Create a project'),
		},
		async run(args, ctx) {
			const platform = (args.platform as PlatformId | undefined) ?? 'browser';
			const result = await ctx.callApi('POST', '/api/projects', {
				name: args.name,
				platform: getPlatform(platform).projectPlatform,
			});
			if (!ok(result)) return apiError(result, 'creating the project');
			const { project, dsn } = result.data as { project: ApiProject; dsn: string };
			return toolText(
				[
					`Created project "${project.name}" (slug: ${project.slug}). The user owns it.`,
					`Dashboard: ${dashboardLink(ctx, `/projects/${project.slug}/issues`)}`,
					'',
					renderGuide(platform, project, dsn),
				].join('\n'),
			);
		},
	},
	{
		scope: 'projects',
		definition: {
			name: 'rotate_dsn',
			title: 'Rotate the DSN key',
			description:
				'Replaces the project\'s DSN key. The old DSN stops working immediately, so every app using it stops reporting until redeployed with the new DSN. Owners and admins; needs "confirm" = the project slug.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					confirm: { type: 'string', maxLength: 200, description: 'Repeat the project slug.' },
				},
				required: ['project', 'confirm'],
				additionalProperties: false,
			},
			annotations: writes('Rotate the DSN key', { destructive: true }),
		},
		async run(args, ctx) {
			if (args.confirm !== args.project) {
				return toolError(
					`Not rotated: "confirm" must be exactly the project slug ("${args.project}").`,
				);
			}
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(args.project as string)}/rotate-key`,
			);
			if (!ok(result)) return apiError(result, `rotating the DSN of "${args.project}"`);
			const { dsn } = result.data as { dsn: string };
			return toolJson({
				rotated: true,
				dsn,
				warning: 'The previous DSN no longer works. Update every app (and secret) that used it.',
			});
		},
	},
	{
		scope: 'projects',
		definition: {
			name: 'delete_project',
			title: 'Delete a project',
			description:
				'Permanently deletes a project with all its issues, events, attachments and source maps. Cannot be undone. Project owner only; needs "confirm" = the project slug.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					confirm: { type: 'string', maxLength: 200, description: 'Repeat the project slug.' },
				},
				required: ['project', 'confirm'],
				additionalProperties: false,
			},
			annotations: writes('Delete a project', { destructive: true, idempotent: true }),
		},
		async run(args, ctx) {
			if (args.confirm !== args.project) {
				return toolError(
					`Not deleted: "confirm" must be exactly the project slug ("${args.project}").`,
				);
			}
			const result = await ctx.callApi('DELETE', `/api/projects/${enc(args.project as string)}`);
			if (!ok(result)) return apiError(result, `deleting project "${args.project}"`);
			return toolJson({ deleted: true, project: args.project });
		},
	},

	{
		scope: 'read',
		definition: {
			name: 'list_debug_files',
			title: 'List debug files',
			description:
				'dSYM objects and ProGuard/R8 mappings stored for a project (debug id, kind, architecture, size), newest first, plus storage used.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					kind: { type: 'string', enum: ['macho', 'proguard'], description: 'Only this kind.' },
					debugId: { type: 'string', maxLength: 64, description: 'Only this debug id / UUID.' },
					limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size (25).' },
					cursor: {
						type: 'string',
						maxLength: 200,
						description: 'nextCursor of the previous page.',
					},
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('List debug files'),
		},
		async run(args, ctx) {
			const query = new URLSearchParams();
			for (const key of ['kind', 'debugId', 'limit', 'cursor']) {
				if (args[key] !== undefined && args[key] !== null) query.set(key, String(args[key]));
			}
			const result = await ctx.callApi(
				'GET',
				`/api/projects/${enc(args.project as string)}/debug-files?${query}`,
			);
			if (!ok(result)) return apiError(result, 'debug files');
			return toolJson(result.data);
		},
	},
	{
		scope: 'read',
		definition: {
			name: 'check_debug_files',
			title: 'Check debug files',
			description:
				"Which dSYMs / ProGuard mappings a crash needs (from the event's debug_meta) and whether each is stored: found, missing or processing. Pass issueId (its latest event), eventId, or debugIds. Use it after an upload to confirm, or on a crash with unreadable frames.",
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					issueId: ISSUE_ARG,
					eventId: { type: 'string', maxLength: 64, description: 'Event id (32 hex).' },
					debugIds: {
						type: 'array',
						items: { type: 'string' },
						description: 'Debug ids / UUIDs to look up (≤200).',
					},
				},
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('Check debug files'),
		},
		async run(args, ctx) {
			const body: Record<string, unknown> = {};
			if (Array.isArray(args.debugIds)) {
				if (!args.debugIds.every((id) => typeof id === 'string'))
					return toolError('"debugIds" must be a list of strings.');
				body.debugIds = args.debugIds;
			} else if (args.eventId) body.eventId = args.eventId;
			else if (args.issueId) body.issueId = args.issueId;
			else return toolError('Pass one of issueId, eventId or debugIds.');
			const slug = args.project as string;
			const result = await ctx.callApi(
				'POST',
				`/api/projects/${enc(slug)}/debug-files/check`,
				body,
			);
			if (!ok(result)) return apiError(result, 'checking debug files');
			const data = result.data as { missing: number };
			return toolJson({
				...(result.data as object),
				...(data.missing > 0
					? {
							nextStep: `Upload the missing files (get_debug_file_upload shows how for project "${slug}"), then check again.`,
						}
					: {}),
			});
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'get_debug_file_upload',
			title: 'How to upload debug files',
			description:
				'Ready-to-use instructions to send dSYMs (iOS) and ProGuard/R8 mappings (Android) to a project: sentry-cli environment, Xcode build phase, GitHub Actions steps, Gradle plugin config and curl commands, with the server and project filled in. The token is always the placeholder $' +
				TOKEN_ENV +
				'.',
			inputSchema: {
				type: 'object',
				properties: { project: PROJECT_ARG },
				required: ['project'],
				additionalProperties: false,
			},
			annotations: readOnly('How to upload debug files'),
		},
		async run(args, ctx) {
			const loaded = await loadProject(ctx, args.project as string);
			if (isToolResult(loaded)) return loaded;
			return toolJson(debugFileGuide(ctx.origin, loaded.project.slug));
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'upload_debug_file',
			title: 'Upload a debug file',
			description:
				'Uploads one small debug file given as base64 (≤8 MB decoded): a dSYM DWARF object (MyApp.app.dSYM/Contents/Resources/DWARF/MyApp) or a ProGuard/R8 mapping.txt. Universal dSYMs are split per architecture. For bigger files or whole folders run sentry-cli (get_debug_file_upload).',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					contentBase64: { type: 'string', description: 'The file, base64-encoded.' },
					name: { type: 'string', maxLength: 200, description: 'File name to show (MyApp).' },
					kind: { type: 'string', enum: ['dsym', 'proguard'], description: 'Optional; detected.' },
					debugId: {
						type: 'string',
						maxLength: 64,
						description:
							'ProGuard only: the UUID built into the app. Derived from the content if omitted.',
					},
				},
				required: ['project', 'contentBase64'],
				additionalProperties: false,
			},
			annotations: writes('Upload a debug file', { idempotent: true }),
		},
		async run(args, ctx) {
			const encoded = (args.contentBase64 as string).replace(/\s+/g, '');
			if (encoded.length > Math.ceil((MCP_UPLOAD_MAX_BYTES * 4) / 3) + 4) {
				return toolError(
					`Too big for the MCP (limit ${MCP_UPLOAD_MAX_BYTES} bytes). Use sentry-cli or the API: get_debug_file_upload.`,
				);
			}
			let bytes: Uint8Array;
			try {
				bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
			} catch {
				return toolError('"contentBase64" is not valid base64.');
			}
			const query = new URLSearchParams();
			for (const key of ['name', 'kind', 'debugId']) {
				if (typeof args[key] === 'string') query.set(key, args[key] as string);
			}
			const result = await ctx.callApiRaw(
				'POST',
				`/api/projects/${enc(args.project as string)}/debug-files?${query}`,
				bytes,
				{ 'Content-Type': 'application/octet-stream' },
			);
			if (!ok(result)) return apiError(result, 'uploading the debug file');
			return toolJson(result.data);
		},
	},
	{
		scope: 'write',
		definition: {
			name: 'delete_debug_file',
			title: 'Delete a debug file',
			description:
				'Deletes one stored debug file (crashes that need it lose their symbols). Project owners and admins only; needs "confirm" = the debug file id.',
			inputSchema: {
				type: 'object',
				properties: {
					project: PROJECT_ARG,
					id: { type: 'string', maxLength: 64, description: 'Debug file id (list_debug_files).' },
					confirm: { type: 'string', maxLength: 64, description: 'Repeat the id.' },
				},
				required: ['project', 'id', 'confirm'],
				additionalProperties: false,
			},
			annotations: writes('Delete a debug file', { destructive: true, idempotent: true }),
		},
		async run(args, ctx) {
			if (args.confirm !== args.id) {
				return toolError(`Not deleted: "confirm" must be exactly the id ("${args.id}").`);
			}
			const result = await ctx.callApi(
				'DELETE',
				`/api/projects/${enc(args.project as string)}/debug-files/${enc(args.id as string)}`,
			);
			if (!ok(result)) return apiError(result, 'deleting the debug file');
			return toolJson(result.data);
		},
	},
];

export function findTool(name: string): Tool | undefined {
	return TOOLS.find((t) => t.definition.name === name);
}

/** Tools this credential can ever use: by token scope, and admin-only ones for admins. */
export function toolsFor(auth: AuthContext): Tool[] {
	return TOOLS.filter(
		(t) => hasScope(auth, t.scope) && (!t.adminOnly || auth.user.role === 'admin'),
	);
}
