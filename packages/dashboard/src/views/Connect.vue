<script setup lang="ts">
import { KeyRound, Sparkles, TerminalSquare } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
// The platform catalog is shared with the worker (MCP setup guides) and the README.
import {
	getPlatform,
	PLATFORMS,
	type PlatformId,
	platformForProject,
} from '../../../workers-sentinel/src/lib/platforms';
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
	UiTag,
} from '../components/ui';
import { useProjectsStore } from '../stores/projects';

type Tab = 'sdks' | 'mcp';
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

const platform = ref<PlatformId>('browser');
watch(
	project,
	(p) => {
		platform.value = platformForProject(p?.platform);
	},
	{ immediate: true },
);
const guide = computed(() => getPlatform(platform.value));
const steps = computed(() =>
	guide.value.steps({ dsn: dsn.value || undefined, project: projectSlug.value || undefined }),
);

// --- MCP ---
const origin = window.location.origin;
const mcpUrl = `${origin}/mcp`;
const client = ref<Client>('claude-code');
const clientOptions: { value: Client; label: string }[] = [
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'json', label: 'Other clients (JSON)' },
];
// Sentinel's own MCP server: remote, HTTP, the same `wst_` token as the API.
const mcpCode = computed(() =>
	client.value === 'claude-code'
		? `claude mcp add --transport http sentinel ${mcpUrl} \\\n  --header "Authorization: Bearer wst_…"`
		: JSON.stringify(
				{
					mcpServers: {
						sentinel: { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer wst_…' } },
					},
				},
				null,
				2,
			),
);
const capabilities = [
	'Create projects and get their DSN (with a "Projects" token)',
	'Step-by-step setup guides for your platform, with the DSN filled in',
	'Send a test event to check a newly connected app',
	'Read issues with stack traces, triage them and leave notes',
	'Change project settings, rotate the DSN key, delete projects',
];
const prompts = [
	'Connect this app to Sentinel',
	'List the unresolved issues in my Sentinel projects',
	'Show the stack trace of the latest TypeError and suggest a fix',
];

// The Sentry MCP server also works against /api/0 (read and triage only).
// Verified against this version (docs/compat-mcp-sentry.md); @latest already
// changed its command line once, so the snippet pins it.
const SENTRY_MCP_PACKAGE = '@sentry/mcp-server@0.51.0';
const sentryMcpCode = `claude mcp add sentry-compat \\\n  -e SENTRY_URL=${origin} \\\n  -e SENTRY_AUTH_TOKEN=wst_… \\\n  -- npx -y ${SENTRY_MCP_PACKAGE} mcp`;
const sentrySupported = [
	'Find organizations and projects, and search issues (is:unresolved, is:resolved, is:ignored)',
	'Read an issue with its exception stack trace and breadcrumbs',
	'Resolve, ignore or reopen an issue',
	'Add notes and read the issue activity',
	'List the events and attachments of an issue',
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
						<UiSelect
							v-model="platform"
							aria-labelledby="connect-platform"
							class="w-full sm:w-64"
							data-testid="connect-platform-select"
						>
							<option v-for="p in PLATFORMS" :key="p.id" :value="p.id">{{ p.name }}</option>
						</UiSelect>
					</div>
					<p class="flex flex-wrap items-center gap-2 text-body-s text-fg-muted" data-testid="connect-platform-summary">
						{{ guide.summary }}
						<UiTag>{{ guide.support === 'verified' ? 'tested with Sentinel' : 'Sentry protocol' }}</UiTag>
					</p>
					<UiAlert v-if="guide.notes.length > 0" tone="info" data-testid="connect-platform-notes">
						<ul class="list-disc pl-5">
							<li v-for="note in guide.notes" :key="note">{{ note }}</li>
						</ul>
					</UiAlert>
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
			<UiAlert tone="info" data-testid="mcp-intro">
				<p>
					Sentinel has its own MCP server at <code class="font-mono">/mcp</code>. Connect it once and your agent can
					set up and manage your projects from the chat:
				</p>
				<ul class="mt-1.5 list-disc pl-5">
					<li v-for="item in capabilities" :key="item">{{ item }}</li>
				</ul>
				<p class="mt-1.5">
					It acts as you, with your role in each project, and only within the token's access. Your client asks
					before every change.
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
									Pick its access: <strong>Read only</strong> to look, <strong>Read &amp; write</strong> to triage and
									configure, <strong>Projects</strong> to also create and delete projects. It is shown once, can
									be revoked anytime and may never expire.
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
							<UiCode :language="client === 'claude-code' ? 'Terminal' : 'mcp.json'" :code="mcpCode" data-testid="mcp-code" />
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

			<UiCard title="Alternative: the Sentry MCP server" meta="Read and triage only" data-testid="mcp-sentry-alt">
				<div class="flex flex-col gap-3 p-5">
					<p class="text-body-s text-fg-muted">
						Sentinel also speaks the Sentry API at <code class="font-mono">/api/0</code>, so the official Sentry MCP
						server works against it — without project setup, guides or test events.
					</p>
					<UiAlert tone="info" data-testid="mcp-compat-note">
						<p>What it can do with Sentinel (verified with version 0.51.0):</p>
						<ul class="mt-1.5 list-disc pl-5">
							<li v-for="item in sentrySupported" :key="item">{{ item }}</li>
						</ul>
						<p class="mt-1.5">
							Not available: searching across all events, releases, teams and DSN keys. Stack traces show the
							frames the SDK sent; source maps are not applied through the MCP.
						</p>
					</UiAlert>
					<UiCode language="Terminal" :code="sentryMcpCode" />
				</div>
			</UiCard>
			<p class="flex items-center gap-1.5 text-caption text-fg-subtle">
				<Sparkles :size="12" aria-hidden="true" />
				Tokens are stored hashed and cannot reach the admin API. Revoke them under API tokens.
			</p>
		</template>
	</div>
</template>
