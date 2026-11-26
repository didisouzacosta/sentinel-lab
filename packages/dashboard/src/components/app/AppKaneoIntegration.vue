<script setup lang="ts">
// Kaneo setup for one project, as four steps (owner/admin only; the page
// renders it only for managers and the server enforces the same rule):
//   1. Kaneo URL + API key → Verify & save (stored as pending),
//   2. choose the project (loads by itself),
//   3. columns and automation → connected,
//   4. two-way sync: the webhook back to Sentinel (one per Kaneo project).
// The API key is write-only: the API returns it masked.
import { RefreshCw, Send, Unplug } from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { kaneoLinks } from '../../lib/integration-links';
import {
	environmentsPhrase,
	type KaneoIntegration,
	kaneoSummary,
	LEVELS,
	levelPhrase,
	splitEnvironments,
} from '../../lib/integrations';
import {
	UiAlert,
	UiButton,
	UiExternalLink,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiSwitch,
} from '../ui';
import AppConnectionHeader from './AppConnectionHeader.vue';
import AppSetupStep from './AppSetupStep.vue';

interface Named {
	id: string;
	name: string;
	slug: string;
}
interface Column extends Named {
	isFinal: boolean;
	position: number;
}

type Step = 1 | 2 | 3 | 4;

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ change: [integration: KaneoIntegration | null] }>();

const toast = useToast();
const askConfirm = useConfirm();

const loading = ref(true);
const loadError = ref<string | null>(null);
const configured = ref(true);
const integration = ref<KaneoIntegration | null>(null);

// Step 1
const baseUrl = ref('');
const apiKey = ref('');
const credentialError = ref<string | null>(null);
const verifying = ref(false);
// Step 2
const workspaceId = ref('');
const kaneoProjectId = ref('');
const workspaces = ref<Named[]>([]);
const projects = ref<Named[]>([]);
const loadingProjects = ref(false);
const projectsError = ref<string | null>(null);
const projectChosen = ref(false);
// Step 3
const columns = ref<Column[]>([]);
const loadingColumns = ref(false);
const columnsError = ref<string | null>(null);
const createColumn = ref('');
const doneColumn = ref('');
const reopenColumn = ref('');
const autoCreate = ref(false);
const minLevel = ref('error');
const environments = ref('');
const saving = ref(false);
// Step 4 + header
const retrying = ref(false);
const testing = ref(false);
const editing = ref<Step | null>(null);
/** What AppSetupStep exposes. */
interface StepHandle {
	focus: () => void;
}
const stepRefs = ref<Record<number, StepHandle | null>>({});
/** Template ref callback for step `n` (focus moves to it when it opens). */
function stepRef(n: number) {
	return (el: unknown) => {
		stepRefs.value[n] = el as StepHandle | null;
	};
}

const base = computed(() => `/api/projects/${props.slug}/integrations/kaneo`);
const summary = computed(() => kaneoSummary(integration.value));
const connected = computed(() => integration.value?.status === 'connected');
const keySaved = computed(
	() => Boolean(integration.value) && integration.value?.credentialsReadable === true,
);
const openColumns = computed(() => columns.value.filter((col) => !col.isFinal));
const apiKeysUrl = computed(() =>
	kaneoLinks.apiKeys(baseUrl.value || integration.value?.baseUrl || ''),
);
const webhookUrl = computed(() =>
	integration.value
		? kaneoLinks.projectIntegrations(integration.value.baseUrl, integration.value.kaneoProjectId)
		: null,
);
const webhookOk = computed(() => integration.value?.webhookStatus === 'installed');

const done = computed<Record<Step, boolean>>(() => ({
	1: keySaved.value,
	2: connected.value || projectChosen.value,
	3: connected.value,
	4: connected.value && webhookOk.value,
}));
const firstOpen = computed<Step | null>(
	() => ([1, 2, 3, 4] as Step[]).find((step) => !done.value[step]) ?? null,
);
function stateOf(step: Step): 'current' | 'done' | 'locked' {
	if (editing.value === step) return 'current';
	if (done.value[step]) return 'done';
	return firstOpen.value === step && editing.value === null ? 'current' : 'locked';
}

const host = computed(() => {
	try {
		return new URL(integration.value?.baseUrl ?? '').host;
	} catch {
		return integration.value?.baseUrl ?? '';
	}
});
const credentialSummary = computed(() => {
	const value = integration.value;
	if (!value) return '';
	return [
		'Verified',
		host.value,
		value.workspaceName ? `workspace ${value.workspaceName}` : null,
		value.apiKey ? `key ${value.apiKey}` : null,
	]
		.filter(Boolean)
		.join(' · ');
});
const projectSummary = computed(() => {
	if (connected.value && integration.value) {
		return `${integration.value.kaneoProjectName} (${integration.value.kaneoProjectSlug})`;
	}
	const chosen = projects.value.find((p) => p.id === kaneoProjectId.value);
	return chosen ? `${chosen.name} (${chosen.slug})` : '';
});
function columnName(slug: string) {
	return columns.value.find((col) => col.slug === slug)?.name ?? slug;
}
const automationSummary = computed(() => {
	const value = integration.value;
	if (!value || !connected.value) return '';
	return [
		`New → ${columnName(value.createColumn)}`,
		`resolved → ${columnName(value.doneColumn)}`,
		`regressions → ${columnName(value.reopenColumn)}`,
		value.autoCreate
			? `automatic for ${levelPhrase(value.minLevel)}, ${environmentsPhrase(value.environments)}`
			: 'tasks created by hand',
	].join(' · ');
});

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function setIntegration(value: KaneoIntegration | null) {
	integration.value = value;
	emit('change', value);
	if (!value) return;
	baseUrl.value = value.baseUrl;
	apiKey.value = '';
	if (value.workspaceId) workspaceId.value = value.workspaceId;
	if (value.status === 'connected') {
		kaneoProjectId.value = value.kaneoProjectId;
		createColumn.value = value.createColumn;
		doneColumn.value = value.doneColumn;
		reopenColumn.value = value.reopenColumn;
		if (!projects.value.some((p) => p.id === value.kaneoProjectId)) {
			projects.value = [
				{ id: value.kaneoProjectId, name: value.kaneoProjectName, slug: value.kaneoProjectSlug },
				...projects.value,
			];
		}
	}
	autoCreate.value = value.autoCreate;
	minLevel.value = value.minLevel;
	environments.value = value.environments.join(', ');
}

async function focusStep(step: Step) {
	await nextTick();
	stepRefs.value[step]?.focus();
}

function applyColumnDefaults() {
	const open = openColumns.value;
	const has = (slug: string) => columns.value.some((col) => col.slug === slug);
	if (!has(createColumn.value)) {
		createColumn.value = (open.find((col) => col.slug === 'to-do') ?? open[0])?.slug ?? '';
	}
	if (!has(doneColumn.value))
		doneColumn.value = columns.value.find((col) => col.isFinal)?.slug ?? '';
	if (!has(reopenColumn.value)) reopenColumn.value = createColumn.value;
}

/** Workspaces and projects the saved key can see. */
async function loadProjects() {
	loadingProjects.value = true;
	projectsError.value = null;
	try {
		const body: Record<string, unknown> = {};
		if (workspaceId.value) body.workspaceId = workspaceId.value;
		let result = await api.post<{ workspaces: Named[]; projects?: Named[] }>(
			`${base.value}/discover`,
			body,
		);
		workspaces.value = result.workspaces;
		if (!workspaceId.value && result.workspaces.length === 1) {
			workspaceId.value = result.workspaces[0].id;
			result = await api.post(`${base.value}/discover`, { workspaceId: workspaceId.value });
		}
		if (result.projects) projects.value = result.projects;
	} catch (err) {
		projectsError.value = message(err, 'Could not reach Kaneo');
	} finally {
		loadingProjects.value = false;
	}
}

async function loadColumns() {
	if (!kaneoProjectId.value) return;
	loadingColumns.value = true;
	columnsError.value = null;
	try {
		const result = await api.post<{ columns?: Column[] }>(`${base.value}/discover`, {
			kaneoProjectId: kaneoProjectId.value,
		});
		columns.value = [...(result.columns ?? [])].sort((a, b) => a.position - b.position);
		applyColumnDefaults();
	} catch (err) {
		columnsError.value = message(err, 'Could not load the columns');
	} finally {
		loadingColumns.value = false;
	}
}

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		const result = await api.get<{ configured: boolean; integration: KaneoIntegration | null }>(
			base.value,
		);
		configured.value = result.configured;
		setIntegration(result.integration);
		if (result.integration?.credentialsReadable && result.configured) {
			if (result.integration.status === 'pending') loadProjects();
			else loadColumns();
		}
	} catch (err) {
		loadError.value = message(err, 'Failed to load the Kaneo integration');
	} finally {
		loading.value = false;
	}
}

async function verify() {
	credentialError.value = null;
	if (!baseUrl.value.trim()) {
		credentialError.value = 'Enter the address of your Kaneo.';
		return;
	}
	if (!apiKey.value.trim() && !integration.value) {
		credentialError.value = 'Paste an API key from your Kaneo account settings.';
		return;
	}
	verifying.value = true;
	try {
		const body: Record<string, unknown> = { baseUrl: baseUrl.value.trim() };
		if (apiKey.value.trim()) body.apiKey = apiKey.value.trim();
		const result = await api.put<{ integration: KaneoIntegration }>(base.value, body);
		setIntegration(result.integration);
		editing.value = null;
		toast.success(
			result.integration.workspaceName
				? `Kaneo key verified · workspace ${result.integration.workspaceName}`
				: 'Kaneo key verified',
		);
		if (result.integration.status === 'pending') {
			focusStep(2);
			loadProjects();
		}
	} catch (err) {
		credentialError.value = message(err, 'Kaneo refused these credentials');
	} finally {
		verifying.value = false;
	}
}

function onWorkspaceChange() {
	kaneoProjectId.value = '';
	projects.value = [];
	loadProjects();
}

function chooseProject() {
	if (!kaneoProjectId.value) return;
	projectChosen.value = true;
	editing.value = connected.value ? 3 : null;
	columns.value = [];
	loadColumns();
	focusStep(3);
}

async function save(extra: Record<string, unknown> = {}) {
	saving.value = true;
	try {
		const wasConnected = connected.value;
		const result = await api.put<{ integration: KaneoIntegration }>(base.value, {
			kaneoProjectId: kaneoProjectId.value,
			createColumn: createColumn.value || undefined,
			doneColumn: doneColumn.value || undefined,
			reopenColumn: reopenColumn.value || undefined,
			autoCreate: autoCreate.value,
			minLevel: minLevel.value,
			environments: splitEnvironments(environments.value),
			...extra,
		});
		setIntegration(result.integration);
		editing.value = null;
		projectChosen.value = false;
		toast.success(wasConnected ? 'Kaneo settings saved' : 'Kaneo connected');
		if (result.integration.webhookStatus !== 'installed') focusStep(4);
	} catch (err) {
		toast.error(message(err, 'Failed to save the Kaneo settings'));
	} finally {
		saving.value = false;
	}
}

/** Saving again retries the webhook install. */
async function retryWebhook() {
	retrying.value = true;
	try {
		const result = await api.put<{ integration: KaneoIntegration }>(base.value, {});
		setIntegration(result.integration);
		if (result.integration.webhookStatus === 'installed') toast.success('Two-way sync is on');
		else toast.error(result.integration.webhookError ?? 'The webhook is still not installed');
	} catch (err) {
		toast.error(message(err, 'Failed to retry the webhook'));
	} finally {
		retrying.value = false;
	}
}

function change(step: Step) {
	editing.value = step;
	if (step === 2) loadProjects();
	if (step === 3 && columns.value.length === 0) loadColumns();
	focusStep(step);
}

function cancelChange() {
	editing.value = null;
	projectChosen.value = false;
	credentialError.value = null;
	if (integration.value) setIntegration(integration.value);
}

async function test() {
	testing.value = true;
	try {
		const result = await api.post<{ project: Named }>(`${base.value}/test`, {});
		toast.success(`Kaneo answered: project ${result.project.name} is reachable`);
	} catch (err) {
		toast.error(message(err, 'Kaneo connection failed'));
	} finally {
		testing.value = false;
	}
}

async function disconnect() {
	const ok = await askConfirm({
		title: 'Disconnect Kaneo?',
		description:
			'Sentinel stops creating and updating Kaneo tasks for this project, forgets the API key and which task belongs to which issue. Tasks already in Kaneo stay there.',
		confirmLabel: 'Disconnect',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(base.value);
		setIntegration(null);
		columns.value = [];
		projects.value = [];
		workspaces.value = [];
		workspaceId.value = '';
		kaneoProjectId.value = '';
		projectChosen.value = false;
		editing.value = null;
		toast.success('Kaneo disconnected');
	} catch (err) {
		toast.error(message(err, 'Failed to disconnect Kaneo'));
	}
}

onMounted(load);
</script>

<template>
	<div class="flex flex-col gap-4" data-testid="kaneo-integration">
		<UiSkeleton v-if="loading" variant="block" class="h-40" label="Loading the Kaneo integration" />
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<UiAlert v-else-if="!configured" tone="warning">
			Integrations are off on this Sentinel instance: the <code>INTEGRATIONS_KEY</code> secret is not set.
		</UiAlert>
		<template v-else>
			<AppConnectionHeader
				:state="summary.state"
				:title="summary.title"
				:summary="!integration ? 'Connect your Kaneo, pick a project and choose where tasks go.' : connected && webhookOk ? automationSummary : connected ? 'New issues become tasks. Closing a task in Kaneo does not resolve its issue yet.' : summary.summary"
			>
				<template v-if="integration" #actions>
					<UiButton v-if="connected" size="sm" :icon="Send" :loading="testing" @click="test">Send test</UiButton>
					<UiButton size="sm" variant="danger" :icon="Unplug" @click="disconnect">Disconnect</UiButton>
				</template>
			</AppConnectionHeader>

			<UiAlert v-if="integration?.lastError" tone="error">
				Last delivery failed: {{ integration.lastError }}
			</UiAlert>

			<ol class="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface" aria-label="Kaneo setup steps">
				<AppSetupStep
					:ref="stepRef(1)"
					:number="1"
					title="Connect your Kaneo"
					:state="stateOf(1)"
					:description="stateOf(1) === 'done' ? credentialSummary : 'Your Kaneo address and an API key. The key stays encrypted on the server.'"
					data-testid="kaneo-step-connect"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(1)">Change</UiButton>
					</template>
					<form class="flex flex-col gap-3" @submit.prevent="verify">
						<UiFormField v-slot="f" label="Kaneo URL">
							<UiInput
								:id="f.id"
								v-model="baseUrl"
								type="url"
								autocomplete="url"
								placeholder="https://kaneo.example.com"
								data-testid="kaneo-url"
							/>
						</UiFormField>
						<UiFormField
							v-slot="f"
							label="API key"
							:error="credentialError"
							:help="integration?.apiKey ? `Saved (${integration.apiKey}). Type a new one to replace it.` : undefined"
						>
							<UiInput
								:id="f.id"
								v-model="apiKey"
								:aria-describedby="f.describedBy"
								:aria-invalid="f.invalid || undefined"
								type="password"
								autocomplete="off"
								:placeholder="integration?.apiKey ?? ''"
								data-testid="kaneo-key"
							/>
						</UiFormField>
						<p class="flex flex-wrap items-center gap-x-1.5 text-body-s text-fg-muted">
							Create one in your Kaneo account settings:
							<UiExternalLink :href="apiKeysUrl" data-testid="kaneo-api-keys-link">Open Kaneo API keys</UiExternalLink>
							<span v-if="!apiKeysUrl" class="text-caption text-fg-subtle">(type the Kaneo URL first)</span>
						</p>
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :loading="verifying">Verify &amp; save</UiButton>
							<UiButton v-if="editing === 1" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>

				<AppSetupStep
					:ref="stepRef(2)"
					:number="2"
					title="Choose the project"
					:state="stateOf(2)"
					:description="stateOf(2) === 'done' ? projectSummary : 'Tasks for this Sentinel project go to one Kaneo project.'"
					locked-hint="Complete step 1 first"
					data-testid="kaneo-step-project"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(2)">Change</UiButton>
					</template>
					<div v-if="loadingProjects" class="flex flex-col gap-2" data-testid="kaneo-projects-loading">
						<p class="flex items-center gap-2 text-body-s font-medium text-fg-muted">
							<RefreshCw :size="14" class="animate-spin" aria-hidden="true" />
							Loading projects from Kaneo…
						</p>
						<UiSkeleton variant="line" :count="2" label="Loading projects from Kaneo" />
					</div>
					<UiAlert v-else-if="projectsError" tone="error" action-label="Try again" @action="loadProjects">
						{{ projectsError }}
					</UiAlert>
					<form v-else class="flex flex-col gap-3" @submit.prevent="chooseProject">
						<UiFormField v-if="workspaces.length > 1" v-slot="f" label="Workspace">
							<UiSelect :id="f.id" v-model="workspaceId" class="w-full" @change="onWorkspaceChange">
								<option value="" disabled>Choose a workspace</option>
								<option v-for="ws in workspaces" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
							</UiSelect>
						</UiFormField>
						<UiFormField
							v-slot="f"
							label="Kaneo project"
							help="Kaneo allows one webhook per project: use a separate Kaneo project for each Sentinel project to keep two-way sync."
						>
							<UiSelect :id="f.id" v-model="kaneoProjectId" class="w-full" :disabled="projects.length === 0" data-testid="kaneo-project">
								<option value="" disabled>Choose a project</option>
								<option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} ({{ p.slug }})</option>
							</UiSelect>
						</UiFormField>
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :disabled="!kaneoProjectId">Continue</UiButton>
							<UiButton v-if="editing === 2" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>

				<AppSetupStep
					:ref="stepRef(3)"
					:number="3"
					title="Columns and automation"
					:state="stateOf(3)"
					:description="stateOf(3) === 'done' ? automationSummary : 'Where tasks start, where resolved ones go, and when to create them by themselves.'"
					locked-hint="Complete step 2 first"
					data-testid="kaneo-step-columns"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(3)">Change</UiButton>
					</template>
					<div v-if="loadingColumns" class="flex flex-col gap-2">
						<p class="flex items-center gap-2 text-body-s font-medium text-fg-muted">
							<RefreshCw :size="14" class="animate-spin" aria-hidden="true" />
							Loading columns from Kaneo…
						</p>
						<UiSkeleton variant="line" :count="2" label="Loading columns from Kaneo" />
					</div>
					<UiAlert v-else-if="columnsError" tone="error" action-label="Try again" @action="loadColumns">
						{{ columnsError }}
					</UiAlert>
					<form v-else class="flex flex-col gap-3" @submit.prevent="save()">
						<div class="grid gap-3 sm:grid-cols-3">
							<UiFormField v-slot="f" label="New tasks go to">
								<UiSelect :id="f.id" v-model="createColumn" class="w-full">
									<option v-for="col in openColumns" :key="col.slug" :value="col.slug">{{ col.name }}</option>
								</UiSelect>
							</UiFormField>
							<UiFormField v-slot="f" label="Resolved issues move to">
								<UiSelect :id="f.id" v-model="doneColumn" class="w-full">
									<option v-for="col in columns" :key="col.slug" :value="col.slug">{{ col.name }}</option>
								</UiSelect>
							</UiFormField>
							<UiFormField v-slot="f" label="Regressions move back to">
								<UiSelect :id="f.id" v-model="reopenColumn" class="w-full">
									<option v-for="col in openColumns" :key="col.slug" :value="col.slug">{{ col.name }}</option>
								</UiSelect>
							</UiFormField>
						</div>
						<div class="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3">
							<div class="flex items-center justify-between gap-3">
								<div>
									<p class="text-body-s font-medium text-fg">Create tasks automatically</p>
									<p class="text-caption text-fg-subtle">One task per new issue (and per regression without a task).</p>
								</div>
								<UiSwitch v-model="autoCreate" label="Create tasks automatically" />
							</div>
							<div v-if="autoCreate" class="grid gap-3 sm:grid-cols-2">
								<UiFormField v-slot="f" label="Minimum level">
									<UiSelect :id="f.id" v-model="minLevel" class="w-full">
										<option v-for="level in LEVELS" :key="level" :value="level">{{ level }}</option>
									</UiSelect>
								</UiFormField>
								<UiFormField v-slot="f" label="Environments" help="Comma-separated. Empty means all.">
									<UiInput :id="f.id" v-model="environments" :aria-describedby="f.describedBy" placeholder="production" />
								</UiFormField>
							</div>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :loading="saving" :disabled="!kaneoProjectId || columns.length === 0">
								{{ connected ? 'Save' : 'Save and connect' }}
							</UiButton>
							<UiButton v-if="editing === 3" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>

				<AppSetupStep
					:ref="stepRef(4)"
					:number="4"
					title="Two-way sync"
					:state="stateOf(4)"
					:description="stateOf(4) === 'done' ? 'On · moving a task to the done column in Kaneo resolves its issue.' : 'Lets Kaneo tell Sentinel when a task is closed.'"
					locked-hint="Complete step 3 first"
					data-testid="kaneo-webhook"
				>
					<UiAlert tone="warning">
						<template v-if="integration?.webhookStatus === 'in_use'">
							Kaneo allows one webhook per project, and {{ integration.kaneoProjectName }} already has one that Sentinel did not create.
						</template>
						<template v-else>{{ integration?.webhookError ?? 'The webhook could not be installed.' }}</template>
					</UiAlert>
					<p v-if="integration?.webhookStatus === 'in_use'" class="text-body-s text-fg-muted">
						Use a separate Kaneo project for each Sentinel project, or remove the other webhook in Kaneo, then try again. Sentinel → Kaneo keeps working meanwhile.
					</p>
					<div class="flex flex-wrap items-center gap-2">
						<UiExternalLink v-if="webhookUrl" variant="button" :href="webhookUrl" data-testid="kaneo-project-integrations-link">
							Open project integrations in Kaneo
						</UiExternalLink>
						<UiButton :icon="RefreshCw" :loading="retrying" @click="retryWebhook">Try again</UiButton>
					</div>
				</AppSetupStep>
			</ol>
		</template>
	</div>
</template>
