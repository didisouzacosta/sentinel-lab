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
type Platform = 'browser' | 'node' | 'workers' | 'python' | 'other';
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
	{ value: 'other', label: 'Other' },
];

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
const host = window.location.host;
const client = ref<Client>('claude-code');
const clientOptions: { value: Client; label: string }[] = [
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'json', label: 'Other clients (JSON)' },
];
const mcpCode = computed(() =>
	client.value === 'claude-code'
		? `claude mcp add sentinel -- npx -y @sentry/mcp-server@latest \\\n  --host=${host} \\\n  --access-token=wst_…`
		: JSON.stringify(
				{
					mcpServers: {
						sentinel: {
							command: 'npx',
							args: ['-y', '@sentry/mcp-server@latest', `--host=${host}`, '--access-token=wst_…'],
						},
					},
				},
				null,
				2,
			),
);
const prompts = [
	'List the unresolved issues in my project from the last 24 hours',
	'Show the stack trace of the latest TypeError and suggest a fix',
	'Resolve that issue once the fix is deployed',
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
				Sentinel speaks the Sentry API at <code class="font-mono">/api/0</code>. Point a Sentry MCP server
				at this instance and your agent can list, inspect, comment on and resolve issues.
			</UiAlert>
			<UiAlert tone="warning" data-testid="mcp-compat-note">
				Compatibility of the Sentry MCP server with Sentinel is still being verified. Listing and reading
				issues use the Sentry-shaped API; some tools may not work yet.
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
