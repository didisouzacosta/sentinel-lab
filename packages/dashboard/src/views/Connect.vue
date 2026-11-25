<script setup lang="ts">
import { KeyRound, Sparkles, TerminalSquare } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiCode,
	UiCopyField,
	UiEmptyState,
	UiFormField,
	UiSegmented,
	UiSelect,
	UiSkeleton,
	UiTabs,
} from '../components/ui';
import { useProjectsStore } from '../stores/projects';

type Tab = 'sdks' | 'mcp';
type Platform = 'browser' | 'node' | 'workers' | 'python' | 'ios' | 'android' | 'other';
type Client = 'claude-code' | 'json';

const route = useRoute();
const router = useRouter();
const projectsStore = useProjectsStore();

const tab = computed<Tab>({
	get: () => (route.query.tab === 'mcp' ? 'mcp' : 'sdks'),
	set: (next) => {
		router.replace({ query: { ...route.query, tab: next === 'sdks' ? undefined : next } });
	},
});
const tabs = [
	{ value: 'sdks' as const, label: 'SDKs', testId: 'connect-tab-sdks' },
	{ value: 'mcp' as const, label: 'MCP · AI agents', testId: 'connect-tab-mcp' },
];

// --- SDKs ---
const projectSlug = computed<string>({
	get: () => (route.query.project as string) || projectsStore.projects[0]?.slug || '',
	set: (slug) => {
		router.replace({ query: { ...route.query, project: slug } });
	},
});
const project = computed(() => projectsStore.projects.find((p) => p.slug === projectSlug.value));
const dsn = ref('');
const dsnLoading = ref(false);
const dsnError = ref<string | null>(null);

async function loadDsn(slug: string) {
	if (!slug) return;
	dsnLoading.value = true;
	dsnError.value = null;
	try {
		const response = await api.get<{ dsn: string }>(`/api/projects/${slug}`);
		dsn.value = response.dsn;
	} catch (err) {
		dsnError.value = err instanceof Error ? err.message : 'Failed to load the DSN';
	} finally {
		dsnLoading.value = false;
	}
}
watch(projectSlug, (slug) => loadDsn(slug), { immediate: true });

function defaultPlatform(platform?: string): Platform {
	if (!platform) return 'browser';
	if (platform.includes('cloudflare')) return 'workers';
	if (platform.includes('node')) return 'node';
	if (platform.includes('python')) return 'python';
	if (/cocoa|apple|ios|swift/.test(platform)) return 'ios';
	if (/android|java|kotlin/.test(platform)) return 'android';
	return 'browser';
}
const platform = ref<Platform>('browser');
watch(
	project,
	(p) => {
		platform.value = defaultPlatform(p?.platform);
	},
	{ immediate: true },
);

const platformOptions: { value: Platform; label: string }[] = [
	{ value: 'browser', label: 'Browser' },
	{ value: 'node', label: 'Node.js' },
	{ value: 'workers', label: 'Cloudflare Workers' },
	{ value: 'python', label: 'Python' },
	{ value: 'ios', label: 'iOS' },
	{ value: 'android', label: 'Android' },
	{ value: 'other', label: 'Other' },
];

// Latest on Maven Central when this page was written; Gradle needs an explicit version.
const ANDROID_SDK_VERSION = '8.65.1';

interface Step {
	title: string;
	description?: string;
	language: string;
	code: string;
}

const steps = computed<Step[]>(() => {
	const d = dsn.value || '<your DSN>';
	switch (platform.value) {
		case 'workers':
			return [
				{
					title: 'Install the SDK',
					language: 'Terminal',
					code: 'npm install @sentry/cloudflare --save',
				},
				{
					title: 'Bind Sentinel in wrangler.jsonc',
					description:
						'A service binding keeps traffic inside Cloudflare — no public HTTP round trip.',
					language: 'wrangler.jsonc',
					code: `{\n  "compatibility_flags": ["nodejs_als"],\n  "services": [\n    { "binding": "SENTINEL", "service": "workers-sentinel", "entrypoint": "SentinelRpc" }\n  ]\n}`,
				},
				{
					title: 'Initialize with the RPC transport',
					language: 'src/index.ts',
					code: `import * as Sentry from "@sentry/cloudflare";\nimport { waitUntil } from "cloudflare:workers";\n\nconst DSN = "${d}";\n\nexport default Sentry.withSentry(\n  (env: Env) => ({\n    dsn: DSN,\n    transport: () => ({\n      send: async (envelope) => {\n        const rpc = env.SENTINEL.captureEnvelope(DSN, envelope);\n        waitUntil(rpc);\n        return { statusCode: (await rpc).status };\n      },\n      flush: async () => true,\n    }),\n  }),\n  { async fetch(request, env, ctx) { return new Response("Hello World!"); } },\n);`,
				},
			];
		case 'node':
			return [
				{ title: 'Install the SDK', language: 'Terminal', code: 'npm install @sentry/node --save' },
				{
					title: 'Initialize it before anything else',
					language: 'instrument.js',
					code: `import * as Sentry from "@sentry/node";\n\nSentry.init({ dsn: "${d}" });`,
				},
			];
		case 'python':
			return [
				{
					title: 'Install the SDK',
					language: 'Terminal',
					code: 'pip install --upgrade sentry-sdk',
				},
				{
					title: 'Initialize it at startup',
					language: 'main.py',
					code: `import sentry_sdk\n\nsentry_sdk.init(dsn="${d}")`,
				},
			];
		case 'ios':
			return [
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
					code: `import Sentry\nimport SwiftUI\n\n@main\nstruct MyApp: App {\n  init() {\n    SentrySDK.start { options in\n      options.dsn = "${d}"\n    }\n  }\n\n  var body: some Scene {\n    WindowGroup { ContentView() }\n  }\n}`,
				},
			];
		case 'android':
			return [
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
					code: `<application>\n  <meta-data\n    android:name="io.sentry.dsn"\n    android:value="${d}" />\n</application>`,
				},
			];
		case 'other':
			return [
				{
					title: 'Use any Sentry SDK',
					description:
						'Sentinel speaks the Sentry envelope protocol. Point the SDK of your language at this DSN.',
					language: 'DSN',
					code: d,
				},
			];
		default:
			return [
				{
					title: 'Install the SDK',
					language: 'Terminal',
					code: 'npm install @sentry/browser --save',
				},
				{
					title: 'Initialize it in your entry file',
					language: 'main.ts',
					code: `import * as Sentry from "@sentry/browser";\n\nSentry.init({ dsn: "${d}" });`,
				},
			];
	}
});

// --- MCP ---
// Verified against this version (docs/compat-mcp-sentry.md); @latest already
// changed its command line once, so the snippet pins it.
const MCP_PACKAGE = '@sentry/mcp-server@0.51.0';
const origin = window.location.origin;
const client = ref<Client>('claude-code');
const clientOptions: { value: Client; label: string }[] = [
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'json', label: 'Other clients (JSON)' },
];
const mcpCode = computed(() =>
	client.value === 'claude-code'
		? `claude mcp add sentinel \\\n  -e SENTRY_URL=${origin} \\\n  -e SENTRY_AUTH_TOKEN=wst_… \\\n  -- npx -y ${MCP_PACKAGE} mcp`
		: JSON.stringify(
				{
					mcpServers: {
						sentinel: {
							command: 'npx',
							args: ['-y', MCP_PACKAGE, 'mcp'],
							env: { SENTRY_URL: origin, SENTRY_AUTH_TOKEN: 'wst_…' },
						},
					},
				},
				null,
				2,
			),
);
const supported = [
	'Find organizations and projects, and search issues (is:unresolved, is:resolved, is:ignored)',
	'Read an issue with its exception stack trace and breadcrumbs',
	'Resolve, ignore or reopen an issue',
	'Add notes and read the issue activity',
	'List the events and attachments of an issue',
];
const prompts = [
	'List the unresolved issues in my Sentinel projects',
	'Show the stack trace of the latest TypeError and suggest a fix',
	'Resolve that issue and leave a note about the fix',
];
</script>

<template>
	<div class="mx-auto flex max-w-5xl flex-col gap-6">
		<header>
			<h1 class="text-heading-l text-fg">Connect</h1>
			<p class="mt-1 text-body-s text-fg-muted">Send errors from your apps and let AI agents work on them.</p>
		</header>

		<UiTabs v-model="tab" label="Connect sections" :items="tabs" />

		<!-- SDKs -->
		<template v-if="tab === 'sdks'">
			<UiCard v-if="!projectsStore.loading && projectsStore.projects.length === 0">
				<UiEmptyState
					title="No projects yet"
					description="An administrator creates projects. Each project has its own DSN for the SDKs."
				/>
			</UiCard>
			<template v-else>
				<UiCard title="DSN" meta="Works with any Sentry SDK" data-testid="connect-dsn">
					<div class="flex flex-col gap-4 p-4 sm:flex-row sm:items-end">
						<UiFormField v-slot="f" label="Project" id="connect-project" class="sm:w-64">
							<UiSelect :id="f.id" v-model="projectSlug" class="w-full">
								<option v-for="p in projectsStore.projects" :key="p.slug" :value="p.slug">{{ p.name }}</option>
							</UiSelect>
						</UiFormField>
						<div class="min-w-0 flex-1">
							<UiSkeleton v-if="dsnLoading" variant="block" label="Loading DSN" class="h-9" />
							<UiAlert v-else-if="dsnError" tone="error" action-label="Try again" @action="loadDsn(projectSlug)">
								{{ dsnError }}
							</UiAlert>
							<UiCopyField v-else :value="dsn" label="DSN" />
						</div>
					</div>
				</UiCard>

				<section aria-labelledby="connect-platform" class="flex flex-col gap-3">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<h2 id="connect-platform" class="text-heading-s text-fg">Platform</h2>
						<UiSegmented v-model="platform" label="Platform" :options="platformOptions" />
					</div>
					<UiCard>
						<ol class="flex flex-col gap-6 p-5">
							<li v-for="(step, i) in steps" :key="step.title" class="flex gap-3.5">
								<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent-text">
									{{ i + 1 }}
								</span>
								<div class="flex min-w-0 flex-1 flex-col gap-2.5">
									<div>
										<h3 class="text-heading-s text-fg">{{ step.title }}</h3>
										<p v-if="step.description" class="mt-0.5 text-body-s text-fg-muted">{{ step.description }}</p>
									</div>
									<UiCode :language="step.language" :code="step.code" />
								</div>
							</li>
						</ol>
					</UiCard>
				</section>
			</template>
		</template>

		<!-- MCP -->
		<template v-else>
			<UiAlert tone="info">
				Sentinel speaks the Sentry API at <code class="font-mono">/api/0</code>. Point the Sentry MCP server
				at this instance and your agent can triage issues from the chat.
			</UiAlert>
			<UiAlert tone="info" data-testid="mcp-compat-note">
				<p>What your agent can do with Sentinel (verified with version 0.51.0):</p>
				<ul class="mt-1.5 list-disc pl-5">
					<li v-for="item in supported" :key="item">{{ item }}</li>
				</ul>
				<p class="mt-1.5">
					Not available yet: searching across all events, releases, teams and DSN keys. Stack traces show
					the frames the SDK sent; source maps are not applied through the MCP.
				</p>
			</UiAlert>

			<UiCard>
				<ol class="flex flex-col gap-6 p-5">
					<li class="flex gap-3.5">
						<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent-text">1</span>
						<div class="flex flex-1 flex-col gap-2.5">
							<div>
								<h3 class="text-heading-s text-fg">Create an API token</h3>
								<p class="mt-0.5 text-body-s text-fg-muted">
									Agents use a personal <code class="font-mono">wst_</code> token. It has your project access, is shown once and can be revoked anytime.
								</p>
							</div>
							<div>
								<UiButton to="/settings/tokens" :icon="KeyRound" size="sm">Create a token</UiButton>
							</div>
						</div>
					</li>
					<li class="flex gap-3.5">
						<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent-text">2</span>
						<div class="flex min-w-0 flex-1 flex-col gap-2.5">
							<h3 class="text-heading-s text-fg">Add the server to your client</h3>
							<UiSegmented v-model="client" label="MCP client" :options="clientOptions" />
							<UiCode :language="client === 'claude-code' ? 'Terminal' : 'mcp.json'" :code="mcpCode" />
						</div>
					</li>
					<li class="flex gap-3.5">
						<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent-text">3</span>
						<div class="flex flex-1 flex-col gap-2.5">
							<div>
								<h3 class="text-heading-s text-fg">Try it</h3>
								<p class="mt-0.5 text-body-s text-fg-muted">Ask your agent things like:</p>
							</div>
							<ul class="flex flex-col gap-2">
								<li
									v-for="prompt in prompts"
									:key="prompt"
									class="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2 text-body-s text-fg"
								>
									<TerminalSquare :size="14" class="shrink-0 text-fg-subtle" aria-hidden="true" />
									“{{ prompt }}”
								</li>
							</ul>
						</div>
					</li>
				</ol>
			</UiCard>
			<p class="flex items-center gap-1.5 text-caption text-fg-subtle">
				<Sparkles :size="12" aria-hidden="true" />
				Tokens are stored hashed and cannot reach the admin API. Revoke them under API tokens.
			</p>
		</template>
	</div>
</template>
