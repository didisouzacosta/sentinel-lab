import { Hono } from 'hono';
import { handleMcpPost } from './mcp/server';
import { authMiddleware, mcpAuthMiddleware } from './middleware/auth';
import { handleQueue } from './queue';
import { adminRoutes } from './routes/admin';
import { api0ErrorTranslator, api0Routes } from './routes/api0';
import { attachmentRoutes } from './routes/attachments';
import { authRoutes, tokenRoutes } from './routes/auth';
import { apiRoot, debugFileCompatRoutes, debugFileRoutes } from './routes/debug-files';
import { eventRoutes } from './routes/events';
import { filterRoutes } from './routes/filters';
import { ingestionRoutes } from './routes/ingestion';
import { integrationRoutes } from './routes/integrations';
import { slackIntegrationRoutes } from './routes/integrations-slack';
import { issueRoutes } from './routes/issues';
import { memberRoutes } from './routes/members';
import { projectRoutes } from './routes/projects';
import { releaseRoutes } from './routes/releases';
import { sourcemapRoutes } from './routes/sourcemaps';
import { webauthnRoutes } from './routes/webauthn';
import type { AuthContext, Env, ProcessJob } from './types';

// Re-export Durable Objects
export { AuthState } from './durable-objects/auth-state';
export { ProjectState } from './durable-objects/project-state';

// Re-export RPC entrypoint for service bindings
export { SentinelRpc } from './rpc';

type Variables = {
	auth?: AuthContext;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS for the dashboard/API surface: the SPA is served same-origin by this
// worker, so cross-origin access is only granted to explicitly configured
// origins (CORS_ORIGINS, comma-separated). Never combines wildcard origins
// with credentials.
app.use('/api/*', async (c, next) => {
	const origin = c.req.header('Origin');
	const allowlist = (c.env.CORS_ORIGINS ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	const allowed = origin && allowlist.includes(origin) ? origin : null;
	if (allowed) {
		c.header('Access-Control-Allow-Origin', allowed);
		c.header('Access-Control-Allow-Credentials', 'true');
		c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
		c.header('Vary', 'Origin');
	}
	// SDK ingestion paths handle their own permissive preflight; everything
	// else answers preflight with a bare 204 and no CORS grant.
	const isSdkPath = /^\/api\/[^/]+\/(envelope|store|security)\/?$/.test(c.req.path);
	if (c.req.method === 'OPTIONS' && !isSdkPath) {
		return c.body(null, 204);
	}
	await next();
	return;
});

// Security headers for every response (API and dashboard assets alike)
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.use('*', async (c, next) => {
	await next();
	const headers = new Headers(c.res.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	const contentType = headers.get('Content-Type') ?? '';
	if (contentType.includes('text/html')) {
		headers.set('Content-Security-Policy', CSP);
	}
	c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	return;
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Public routes (no auth required)
app.route('/api/auth', authRoutes);

// API token management routes (session auth required)
app.use('/api/auth/tokens/*', authMiddleware);
app.use('/api/auth/tokens', authMiddleware);
app.route('/api/auth/tokens', tokenRoutes);

// Passkey (WebAuthn) routes. Login ceremonies are public; register and
// credential management are session-only (the manage router itself rejects
// `wst_` API tokens with 403 session_required — AuthContext.session is
// synthesized for API tokens, so the raw token prefix is the discriminator).
app.use('/api/auth/webauthn/register/*', authMiddleware);
app.use('/api/auth/webauthn/verify/register', authMiddleware);
app.use('/api/auth/webauthn/credentials/*', authMiddleware);
app.use('/api/auth/webauthn/credentials', authMiddleware);
app.route('/api/auth/webauthn', webauthnRoutes);

// Ingestion routes (DSN auth, not session auth)
app.route('/api', ingestionRoutes);

// Protected routes (session auth required)
app.use('/api/projects/*', authMiddleware);
app.route('/api/projects', projectRoutes);
app.route('/api/projects', memberRoutes);
app.route('/api/projects', issueRoutes);
app.route('/api/projects', eventRoutes);
app.route('/api/projects', attachmentRoutes);
app.route('/api/projects', releaseRoutes);
app.route('/api/projects', sourcemapRoutes);
app.route('/api/projects', debugFileRoutes);
app.route('/api/projects', filterRoutes);
app.route('/api/projects', integrationRoutes);
app.route('/api/projects', slackIntegrationRoutes);

// Admin routes (session auth required)
app.use('/api/admin/*', authMiddleware);
app.route('/api/admin', adminRoutes);

// Sentry /api/0 API (agentic triage + event-attachment surface). The
// error-shape translator is registered BEFORE authMiddleware: registration
// order is wrap order in Hono, so the translator's `await next()` wraps
// auth's early 401 returns and rewrites them to {"detail": …}. Auth still
// runs before route matching, preserving the /api/projects/* precedence
// (anonymous probes of unknown /api/0 paths answer 401, not 404).
app.use('/api/0/*', api0ErrorTranslator);
app.use('/api/0/*', authMiddleware);
// Debug files (CI mirror + sentry-cli protocol) before api0Routes, whose
// GET catch-all would otherwise answer their paths with 404.
app.route('/api/0', debugFileCompatRoutes);
// API root (`sentry-cli info`).
app.get('/api/0/', apiRoot);
app.route('/api/0', api0Routes);

/** JSON body of an internal API answer, for MCP tools. */
async function parseApi(response: Response): Promise<{ status: number; data: unknown }> {
	const text = await response.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { error: 'non_json_response', message: text.slice(0, 200) };
	}
	return { status: response.status, data };
}

// Sentinel MCP server (Streamable HTTP, stateless, JSON responses). Bearer
// auth like the API (`wst_` token or session); the write-scope rule is not
// applied to the POST itself — each tool calls the protected routes below
// with the caller's credential, where scopes and project roles apply per
// action (src/mcp/tools.ts). Defined before the SPA catch-all.
app.use('/mcp', mcpAuthMiddleware);
app.post('/mcp', (c) => {
	const auth = c.get('auth') as AuthContext;
	const authorization = c.req.header('Authorization') ?? '';
	const origin = new URL(c.req.url).origin;
	const dispatch = async (request: Request): Promise<Response> =>
		app.fetch(request, c.env, c.executionCtx);
	return handleMcpPost(c.req.raw, {
		auth,
		origin,
		async callApi(method, path, body) {
			return parseApi(
				await dispatch(
					new Request(`${origin}${path}`, {
						method,
						headers: { Authorization: authorization, 'Content-Type': 'application/json' },
						body: body === undefined ? undefined : JSON.stringify(body),
					}),
				),
			);
		},
		async callApiRaw(method, path, body, headers = {}) {
			return parseApi(
				await dispatch(
					new Request(`${origin}${path}`, {
						method,
						headers: { ...headers, Authorization: authorization },
						body,
					}),
				),
			);
		},
		fetchInternal: (path, init) => dispatch(new Request(`${origin}${path}`, init)),
	});
});
// No server-initiated stream and no sessions: only POST is spoken here.
app.on(['GET', 'DELETE', 'PUT', 'PATCH'], '/mcp', (c) =>
	c.json(
		{ error: 'method_not_allowed', message: 'The Sentinel MCP endpoint only accepts POST' },
		405,
		{
			Allow: 'POST',
		},
	),
);

// Unknown /api/* GETs must not fall through to the SPA: API clients get a
// JSON 404 instead of the dashboard's HTML (served with a 200). Auth runs
// first on protected namespaces, so anonymous probes of unknown protected
// paths still answer 401, not 404.
app.get('*', (c) => {
	if (c.req.path.startsWith('/api/')) {
		return c.json({ error: 'not_found' }, 404);
	}
	// Assets binding handles static files
	return c.env.ASSETS?.fetch(c.req.raw) ?? c.text('Dashboard not found', 404);
});

// Same contract for unmatched non-GET /api/* methods (e.g. POST /api/nope)
app.notFound((c) => {
	if (c.req.path.startsWith('/api/')) {
		return c.json({ error: 'not_found' }, 404);
	}
	return c.text('Not Found', 404);
});

export default {
	fetch: app.fetch,
	queue: handleQueue,
} satisfies ExportedHandler<Env, ProcessJob>;

/** The Hono app, for embedding (template/). Re-export `handleQueue` as `queue` to enable background jobs. */
export function workersSentinel() {
	return app;
}

export { handleQueue };
