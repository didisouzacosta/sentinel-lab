/**
 * Platform catalog: the one source for "how do I send errors from X to
 * Sentinel". The dashboard's Connect page and admin project form import it,
 * the README table mirrors it, and the MCP `get_setup_guide` tool (plan
 * phase 3) serves it. Keep it dependency-free plain TypeScript: it is
 * compiled by both the worker and the dashboard (DOM lib, no Workers types).
 *
 * Sentinel speaks the Sentry ingestion protocol, so every entry is "a
 * Sentry SDK (or a hand-built envelope) pointed at the Sentinel DSN". What
 * differs per platform is the package, where init goes, and the caveats.
 */

export type PlatformId =
	| 'browser'
	| 'node'
	| 'cloudflare-workers'
	| 'astro'
	| 'deno'
	| 'bun'
	| 'python'
	| 'php'
	| 'ios'
	| 'android'
	| 'envelope'
	| 'other';

export interface SetupStep {
	title: string;
	description?: string;
	/** Code block label: a file name, `Terminal`, `DSN`… */
	language: string;
	code: string;
}

export interface SetupContext {
	/** The project's DSN; a placeholder is used when missing. */
	dsn?: string;
}

export interface PlatformGuide {
	id: PlatformId;
	/** Display name. */
	name: string;
	/** One line: what it covers and how. */
	summary: string;
	/** Value stored on `projects.platform` for new projects. */
	projectPlatform: string;
	/**
	 * `verified` — exercised end to end against Sentinel (lab/ suites or the
	 * worker's own tests); `protocol` — uses the same Sentry envelope wire
	 * format, expected to work but not run here yet.
	 */
	support: 'verified' | 'protocol';
	/** Where the verification lives, for `verified` entries. */
	verifiedBy?: string;
	/** Runs in a browser: the page's CSP must allow the Sentinel origin. */
	browser: boolean;
	/** Limitations worth knowing before relying on it. */
	notes: string[];
	steps(ctx: SetupContext): SetupStep[];
}

const DSN_PLACEHOLDER = '<your DSN>';

/** Origin errors are POSTed to (what a CSP `connect-src` must allow). */
export function ingestOrigin(dsn?: string): string {
	if (!dsn) return '<your Sentinel origin>';
	try {
		return new URL(dsn).origin;
	} catch {
		return '<your Sentinel origin>';
	}
}

// Latest on Maven Central when this was written; Gradle needs an explicit version.
const ANDROID_SDK_VERSION = '8.65.1';

/**
 * A hand-built envelope over fetch: no SDK, ~30 lines, runs unchanged on
 * Workers, Deno, Bun, Node 18+ and browsers. The DSN rides in the envelope
 * header, which Sentinel accepts as the credential.
 */
function envelopeReporter(dsn: string): string {
	return `const DSN = "${dsn}";

/** V8 stack line → Sentry frame (Sentry wants the innermost frame last). */
function parseFrames(stack = "") {
  return stack
    .split("\\n")
    .slice(1, 50)
    .map((line) => {
      const m = line.match(/at (?:(.+?) \\()?(.+?):(\\d+):(\\d+)\\)?$/);
      return m
        ? { function: m[1] ?? "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2].includes("node_modules") }
        : { function: line.trim() };
    })
    .reverse();
}

export function reportError(
  error: unknown,
  extra: { environment?: string; release?: string; tags?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(DSN);
  const endpoint = \`\${url.protocol}//\${url.host}/api\${url.pathname}/envelope/\`;
  const err = error instanceof Error ? error : new Error(String(error));
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    ...extra,
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames: parseFrames(err.stack) } }] },
  };
  const body = [
    JSON.stringify({ event_id: eventId, dsn: DSN, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\\n");
  return fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body });
}`;
}

export const PLATFORMS: readonly PlatformGuide[] = [
	{
		id: 'browser',
		name: 'Browser',
		summary: 'Any web front end (React, Vue, Svelte, plain JS) with @sentry/browser.',
		projectPlatform: 'javascript',
		support: 'verified',
		verifiedBy: 'lab/web (official @sentry/browser build)',
		browser: true,
		notes: [
			'Upload source maps per release (project Settings → Source maps) to see original file names and lines.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Install the SDK',
				language: 'Terminal',
				code: 'npm install @sentry/browser --save',
			},
			{
				title: 'Initialize it in your entry file',
				language: 'main.ts',
				code: `import * as Sentry from "@sentry/browser";\n\nSentry.init({ dsn: "${dsn}" });`,
			},
		],
	},
	{
		id: 'node',
		name: 'Node.js',
		summary:
			'Servers and scripts on Node.js (Express, Fastify, Nest, Hono on Node) with @sentry/node.',
		projectPlatform: 'node',
		support: 'verified',
		verifiedBy: 'lab/node-test.mjs (official @sentry/node)',
		browser: false,
		notes: [],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{ title: 'Install the SDK', language: 'Terminal', code: 'npm install @sentry/node --save' },
			{
				title: 'Initialize it before anything else',
				language: 'instrument.js',
				code: `import * as Sentry from "@sentry/node";\n\nSentry.init({ dsn: "${dsn}" });`,
			},
		],
	},
	{
		id: 'cloudflare-workers',
		name: 'Cloudflare Workers',
		summary: 'Workers, including Hono apps, with @sentry/cloudflare.',
		projectPlatform: 'cloudflare-workers',
		support: 'protocol',
		browser: false,
		notes: [
			'Hono catches errors in app.onError, so the SDK never sees them: report them there, as below.',
			'Same Cloudflare account as Sentinel? A service binding to its SentinelRpc entrypoint skips the public HTTP hop (see the README, "Service Binding with RPC").',
			'Prefer no SDK at all? The "No SDK (envelope)" guide is ~30 lines and has no dependencies.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Install the SDK',
				language: 'Terminal',
				code: 'npm install @sentry/cloudflare --save',
			},
			{
				title: 'Enable AsyncLocalStorage',
				language: 'wrangler.jsonc',
				code: '{\n  "compatibility_flags": ["nodejs_als"]\n}',
			},
			{
				title: 'Store the DSN as a secret',
				language: 'Terminal',
				code: `npx wrangler secret put SENTINEL_DSN\n# paste: ${dsn}`,
			},
			{
				title: 'Wrap the worker (Hono shown)',
				language: 'src/index.ts',
				code: `import * as Sentry from "@sentry/cloudflare";\nimport { Hono } from "hono";\n\nconst app = new Hono<{ Bindings: Env }>();\n\napp.onError((err, c) => {\n  Sentry.captureException(err);\n  return c.json({ error: "internal_error" }, 500);\n});\n\nexport default Sentry.withSentry(\n  (env: Env) => ({ dsn: env.SENTINEL_DSN }),\n  app,\n);`,
			},
		],
	},
	{
		id: 'astro',
		name: 'Astro',
		summary:
			'Astro sites (static or on the Cloudflare adapter): browser errors plus server routes.',
		projectPlatform: 'javascript-astro',
		support: 'protocol',
		browser: true,
		notes: [
			'The DSN is public by design: it can only send events, never read them.',
			'Server-side code on the Cloudflare adapter follows the Cloudflare Workers (or No SDK) guide.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Install the browser SDK',
				language: 'Terminal',
				code: 'npm install @sentry/browser --save',
			},
			{
				title: 'Initialize it from the base layout',
				description: 'Astro bundles <script> tags in components, so this runs once per page load.',
				language: 'src/layouts/Base.astro',
				code: `<script>\n  import * as Sentry from "@sentry/browser";\n\n  Sentry.init({ dsn: "${dsn}" });\n</script>`,
			},
			{
				title: 'Allow the Sentinel origin in your CSP',
				language: 'Content-Security-Policy',
				code: `connect-src 'self' ${ingestOrigin(dsn)}`,
			},
		],
	},
	{
		id: 'deno',
		name: 'Deno',
		summary: 'Deno and Deno Deploy with @sentry/deno.',
		projectPlatform: 'deno',
		support: 'protocol',
		browser: false,
		notes: [
			'A Deno project deployed to Cloudflare Workers runs on Workers, not Deno: use that guide (or No SDK).',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Initialize the SDK',
				language: 'main.ts',
				code: `import * as Sentry from "npm:@sentry/deno";\n\nSentry.init({ dsn: "${dsn}" });`,
			},
			{
				title: 'Allow the network call',
				language: 'Terminal',
				code: `deno run --allow-net=${hostOf(dsn)} main.ts`,
			},
		],
	},
	{
		id: 'bun',
		name: 'Bun',
		summary: 'Bun servers and scripts with @sentry/bun.',
		projectPlatform: 'bun',
		support: 'protocol',
		browser: false,
		notes: [],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{ title: 'Install the SDK', language: 'Terminal', code: 'bun add @sentry/bun' },
			{
				title: 'Initialize it before anything else',
				language: 'instrument.ts',
				code: `import * as Sentry from "@sentry/bun";\n\nSentry.init({ dsn: "${dsn}" });`,
			},
		],
	},
	{
		id: 'python',
		name: 'Python',
		summary: 'Python apps (Django, Flask, FastAPI…) with sentry-sdk.',
		projectPlatform: 'python',
		support: 'protocol',
		browser: false,
		notes: [],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{ title: 'Install the SDK', language: 'Terminal', code: 'pip install --upgrade sentry-sdk' },
			{
				title: 'Initialize it at startup',
				language: 'main.py',
				code: `import sentry_sdk\n\nsentry_sdk.init(dsn="${dsn}")`,
			},
		],
	},
	{
		id: 'php',
		name: 'PHP',
		summary: 'PHP apps (Laravel, Symfony, plain PHP) with sentry/sentry.',
		projectPlatform: 'php',
		support: 'verified',
		verifiedBy: 'lab/php (sentry/sentry ^4)',
		browser: false,
		notes: [],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{ title: 'Install the SDK', language: 'Terminal', code: 'composer require sentry/sentry' },
			{
				title: 'Initialize it at bootstrap',
				language: 'index.php',
				code: `<?php\nrequire __DIR__ . '/vendor/autoload.php';\n\n\\Sentry\\init(['dsn' => '${dsn}']);`,
			},
		],
	},
	{
		id: 'ios',
		name: 'iOS',
		summary: 'Swift / SwiftUI apps with sentry-cocoa.',
		projectPlatform: 'cocoa',
		support: 'verified',
		verifiedBy: 'lab/native-test.mjs (simulated crashes) and SentinelIOS',
		browser: false,
		notes: [
			'Sentinel does not process dSYM files yet: crashes from release builds may show addresses instead of function names.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Add the SDK with Swift Package Manager',
				description:
					'In Xcode: File → Add Package Dependencies…, paste this URL and pick "Up to Next Major Version".',
				language: 'Package URL',
				code: 'https://github.com/getsentry/sentry-cocoa.git',
			},
			{
				title: 'Start it when the app launches',
				description:
					'Sentinel does not process dSYM files yet: crashes from release builds may show addresses instead of function names.',
				language: 'MyApp.swift',
				code: `import Sentry\nimport SwiftUI\n\n@main\nstruct MyApp: App {\n  init() {\n    SentrySDK.start { options in\n      options.dsn = "${dsn}"\n    }\n  }\n\n  var body: some Scene {\n    WindowGroup { ContentView() }\n  }\n}`,
			},
		],
	},
	{
		id: 'android',
		name: 'Android',
		summary: 'Android apps with sentry-android.',
		projectPlatform: 'android',
		support: 'verified',
		verifiedBy: 'lab/native-test.mjs (simulated crashes)',
		browser: false,
		notes: [
			'Sentinel does not apply R8/ProGuard mapping files yet, so obfuscated release builds show obfuscated names.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Add the SDK to your app module',
				language: 'app/build.gradle.kts',
				code: `dependencies {\n  implementation("io.sentry:sentry-android:${ANDROID_SDK_VERSION}")\n}`,
			},
			{
				title: 'Set the DSN in the manifest',
				description:
					'The SDK starts on its own when the app launches. Sentinel does not apply R8/ProGuard mapping files yet, so obfuscated release builds show obfuscated names.',
				language: 'AndroidManifest.xml',
				code: `<application>\n  <meta-data\n    android:name="io.sentry.dsn"\n    android:value="${dsn}" />\n</application>`,
			},
		],
	},
	{
		id: 'envelope',
		name: 'No SDK (envelope)',
		summary:
			'A dependency-free reporter: one fetch of a Sentry envelope. Runs on Workers, Deno, Bun, Node 18+ and browsers.',
		projectPlatform: 'envelope',
		support: 'verified',
		verifiedBy: 'packages/workers-sentinel/test/ingestion-envelope-dsn.test.ts',
		browser: false,
		notes: [
			'Captures what you pass to reportError: wire it into your error handler (Hono app.onError, window "error"/"unhandledrejection", etc.).',
			'No breadcrumbs, sessions or automatic context — add tags/extra yourself. Never put personal data in them.',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Add the reporter',
				language: 'report-error.ts',
				code: envelopeReporter(dsn),
			},
			{
				title: 'Call it from your error handler',
				description:
					'On Workers keep the request alive until the report is sent; in browsers navigator.sendBeacon also works (same body, no headers needed).',
				language: 'src/index.ts',
				code: `import { reportError } from "./report-error";\n\napp.onError((err, c) => {\n  c.executionCtx.waitUntil(reportError(err, { environment: "production" }).catch(() => {}));\n  return c.json({ error: "internal_error" }, 500);\n});`,
			},
			{
				title: 'In a browser, allow the Sentinel origin in your CSP',
				language: 'Content-Security-Policy',
				code: `connect-src 'self' ${ingestOrigin(dsn)}`,
			},
		],
	},
	{
		id: 'other',
		name: 'Other',
		summary: 'Any other Sentry SDK (Go, Ruby, .NET, Rust, Java…): point it at the Sentinel DSN.',
		projectPlatform: 'other',
		support: 'protocol',
		browser: false,
		notes: [
			'Not supported: sentry-cli uploads, performance/tracing, replays and profiles (dropped on ingest).',
		],
		steps: ({ dsn = DSN_PLACEHOLDER }) => [
			{
				title: 'Use any Sentry SDK',
				description:
					'Sentinel speaks the Sentry envelope protocol. Point the SDK of your language at this DSN.',
				language: 'DSN',
				code: dsn,
			},
		],
	},
];

function hostOf(dsn: string): string {
	try {
		return new URL(dsn).host;
	} catch {
		return '<your Sentinel host>';
	}
}

export function getPlatform(id: PlatformId): PlatformGuide {
	const guide = PLATFORMS.find((p) => p.id === id);
	if (!guide) throw new Error(`unknown platform: ${id}`);
	return guide;
}

/**
 * Best guide for a project's stored `platform` value: an exact catalog
 * match first, then the Sentry-style slugs older projects carry
 * (`javascript-react`, `node-express`, `cocoa`, `apple-ios`…).
 */
export function platformForProject(platform?: string | null): PlatformId {
	if (!platform) return 'browser';
	const exact = PLATFORMS.find((p) => p.projectPlatform === platform || p.id === platform);
	if (exact) return exact.id;
	const p = platform.toLowerCase();
	if (p.includes('cloudflare') || p.includes('workers')) return 'cloudflare-workers';
	if (p.includes('astro')) return 'astro';
	if (p.includes('deno')) return 'deno';
	if (p.includes('bun')) return 'bun';
	if (p.includes('node')) return 'node';
	if (p.includes('python')) return 'python';
	if (p.includes('php')) return 'php';
	// before the Android check: "javascript" contains "java"
	if (p.startsWith('javascript')) return 'browser';
	if (/cocoa|apple|ios|swift/.test(p)) return 'ios';
	if (/android|java|kotlin/.test(p)) return 'android';
	return 'other';
}
