<script setup lang="ts">
// Kaneo integration settings for one project (owner/admin only; the parent
// renders it only for managers and the server enforces the same rule).
// Secrets are write-only here: the API returns them masked, and the inputs
// start empty with the masked value as a hint.
import { PlugZap, RefreshCw, Unplug } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiSwitch,
} from '../ui';

export interface KaneoIntegration {
	id: string;
	enabled: boolean;
	baseUrl: string;
	workspaceId: string;
	kaneoProjectId: string;
	kaneoProjectName: string;
	kaneoProjectSlug: string;
	createColumn: string;
	doneColumn: string;
	reopenColumn: string;
	autoCreate: boolean;
	minLevel: string;
	environments: string[];
	apiKey: string | null;
	accessClientId: string | null;
	hasAccessToken: boolean;
	credentialsReadable: boolean;
	lastError: string | null;
	lastErrorAt: string | null;
}

interface Named {
	id: string;
	name: string;
	slug: string;
}
interface Column extends Named {
	isFinal: boolean;
	position: number;
}

const props = defineProps<{ slug: string }>();

const toast = useToast();
const askConfirm = useConfirm();

const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];

const loading = ref(true);
const loadError = ref<string | null>(null);
const configured = ref(true);
const integration = ref<KaneoIntegration | null>(null);

// Form state
const baseUrl = ref('');
const apiKey = ref('');
const accessClientId = ref('');
const accessClientSecret = ref('');
const workspaceId = ref('');
const kaneoProjectId = ref('');
const createColumn = ref('');
const doneColumn = ref('');
const reopenColumn = ref('');
const autoCreate = ref(false);
const minLevel = ref('error');
const environments = ref('');

const workspaces = ref<Named[]>([]);
const projects = ref<Named[]>([]);
const columns = ref<Column[]>([]);
const discovering = ref(false);
const discoverError = ref<string | null>(null);
const saving = ref(false);
const testing = ref(false);

const base = computed(() => `/api/projects/${props.slug}/integrations/kaneo`);
const connected = computed(() => integration.value !== null);
const openColumns = computed(() => columns.value.filter((col) => !col.isFinal));
const canSave = computed(
	() =>
		Boolean(baseUrl.value && kaneoProjectId.value) && (connected.value || Boolean(apiKey.value)),
);

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function credentialBody() {
	const body: Record<string, unknown> = { baseUrl: baseUrl.value };
	if (apiKey.value) body.apiKey = apiKey.value;
	if (accessClientId.value || accessClientSecret.value) {
		body.accessClientId = accessClientId.value;
		body.accessClientSecret = accessClientSecret.value;
	}
	return body;
}

function fillForm(value: KaneoIntegration) {
	baseUrl.value = value.baseUrl;
	workspaceId.value = value.workspaceId;
	kaneoProjectId.value = value.kaneoProjectId;
	createColumn.value = value.createColumn;
	doneColumn.value = value.doneColumn;
	reopenColumn.value = value.reopenColumn;
	autoCreate.value = value.autoCreate;
	minLevel.value = value.minLevel;
	environments.value = value.environments.join(', ');
	apiKey.value = '';
	accessClientId.value = '';
	accessClientSecret.value = '';
	// The saved project shows even before the pickers load.
	projects.value = [
		{ id: value.kaneoProjectId, name: value.kaneoProjectName, slug: value.kaneoProjectSlug },
	];
}

function applyColumnDefaults() {
	const open = openColumns.value;
	const has = (slug: string) => columns.value.some((col) => col.slug === slug);
	if (!has(createColumn.value)) {
		createColumn.value = (open.find((col) => col.slug === 'to-do') ?? open[0])?.slug ?? '';
	}
	if (!has(doneColumn.value)) {
		doneColumn.value = columns.value.find((col) => col.isFinal)?.slug ?? '';
	}
	if (!has(reopenColumn.value)) reopenColumn.value = createColumn.value;
}

/** Ask the server what these credentials can see (falls back to the saved ones). */
async function discover(scope: 'workspaces' | 'projects' | 'columns' = 'workspaces') {
	if (!baseUrl.value) return;
	discovering.value = true;
	discoverError.value = null;
	try {
		const body = credentialBody();
		if (scope !== 'workspaces' || workspaceId.value)
			body.workspaceId = workspaceId.value || undefined;
		if (scope === 'columns' || kaneoProjectId.value)
			body.kaneoProjectId = kaneoProjectId.value || undefined;
		const result = await api.post<{
			workspaces: Named[];
			projects?: Named[];
			columns?: Column[];
		}>(`${base.value}/discover`, body);
		workspaces.value = result.workspaces;
		if (!workspaceId.value && result.workspaces.length === 1) {
			workspaceId.value = result.workspaces[0].id;
			return discover('projects');
		}
		if (result.projects) projects.value = result.projects;
		if (result.columns) {
			columns.value = [...result.columns].sort((a, b) => a.position - b.position);
			applyColumnDefaults();
		}
	} catch (err) {
		discoverError.value = message(err, 'Could not reach Kaneo');
	} finally {
		discovering.value = false;
	}
}

function onWorkspaceChange() {
	kaneoProjectId.value = '';
	projects.value = [];
	columns.value = [];
	discover('projects');
}

function onProjectChange() {
	columns.value = [];
	if (kaneoProjectId.value) discover('columns');
}

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		const result = await api.get<{ configured: boolean; integration: KaneoIntegration | null }>(
			base.value,
		);
		configured.value = result.configured;
		integration.value = result.integration;
		if (result.integration) {
			fillForm(result.integration);
			if (result.configured && result.integration.credentialsReadable) {
				discover('columns');
			}
		}
	} catch (err) {
		loadError.value = message(err, 'Failed to load the Kaneo integration');
	} finally {
		loading.value = false;
	}
}

async function save() {
	saving.value = true;
	try {
		const body = {
			...credentialBody(),
			kaneoProjectId: kaneoProjectId.value,
			createColumn: createColumn.value || undefined,
			doneColumn: doneColumn.value || undefined,
			reopenColumn: reopenColumn.value || undefined,
			autoCreate: autoCreate.value,
			minLevel: minLevel.value,
			environments: environments.value
				.split(',')
				.map((name) => name.trim())
				.filter(Boolean),
		};
		const result = await api.put<{ integration: KaneoIntegration }>(base.value, body);
		const wasConnected = connected.value;
		integration.value = result.integration;
		fillForm(result.integration);
		toast.success(wasConnected ? 'Kaneo settings saved' : 'Kaneo connected');
	} catch (err) {
		toast.error(message(err, 'Failed to save the Kaneo settings'));
	} finally {
		saving.value = false;
	}
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
			'Sentinel stops creating and updating Kaneo tasks for this project and forgets which task belongs to which issue. Tasks already in Kaneo stay there.',
		confirmLabel: 'Disconnect',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(base.value);
		integration.value = null;
		columns.value = [];
		projects.value = [];
		workspaces.value = [];
		workspaceId.value = '';
		kaneoProjectId.value = '';
		toast.success('Kaneo disconnected');
	} catch (err) {
		toast.error(message(err, 'Failed to disconnect Kaneo'));
	}
}

onMounted(load);
</script>

<template>
	<UiCard id="kaneo" title="Kaneo" :meta="connected ? 'Connected' : 'Not connected'" class="scroll-mt-20" padded>
		<UiSkeleton v-if="loading" class="h-24 w-full" />
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<UiAlert v-else-if="!configured" tone="warning">
			Integrations are off on this Sentinel instance: the <code>INTEGRATIONS_KEY</code> secret is not set.
		</UiAlert>
		<form v-else class="flex flex-col gap-4" data-testid="kaneo-form" @submit.prevent="save">
			<p class="text-body-s text-fg-muted">
				Create a Kaneo task for an issue with one click (or automatically for new issues), and keep both sides
				in sync: resolving the issue closes the task, and closing the task resolves the issue.
			</p>

			<UiAlert v-if="integration?.lastError" tone="error">
				Last delivery failed: {{ integration.lastError }}
			</UiAlert>
			<UiAlert v-if="integration && !integration.credentialsReadable" tone="warning">
				The saved credentials can no longer be read. Enter the API key and Access token again.
			</UiAlert>

			<div class="grid gap-3 sm:grid-cols-2">
				<UiFormField v-slot="f" label="Kaneo URL" class="sm:col-span-2">
					<UiInput
						:id="f.id"
						v-model="baseUrl"
						:aria-describedby="f.describedBy"
						type="url"
						placeholder="https://kaneo.example.com"
						autocomplete="off"
					/>
				</UiFormField>
				<UiFormField
					v-slot="f"
					label="API key"
					:help="integration?.apiKey ? `Saved (${integration.apiKey}). Type a new one to replace it.` : 'Create it in Kaneo under Settings → API keys.'"
					class="sm:col-span-2"
				>
					<UiInput
						:id="f.id"
						v-model="apiKey"
						:aria-describedby="f.describedBy"
						type="password"
						autocomplete="off"
						:placeholder="integration?.apiKey ?? ''"
					/>
				</UiFormField>
				<UiFormField
					v-slot="f"
					label="Access client ID"
					:help="integration?.hasAccessToken ? `Saved (${integration.accessClientId}).` : 'Only if Kaneo sits behind Cloudflare Access.'"
				>
					<UiInput :id="f.id" v-model="accessClientId" :aria-describedby="f.describedBy" autocomplete="off" />
				</UiFormField>
				<UiFormField v-slot="f" label="Access client secret">
					<UiInput
						:id="f.id"
						v-model="accessClientSecret"
						:aria-describedby="f.describedBy"
						type="password"
						autocomplete="off"
					/>
				</UiFormField>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<UiButton :icon="RefreshCw" :loading="discovering" :disabled="!baseUrl" @click="discover()">
					{{ workspaces.length ? 'Reload projects' : 'Load projects' }}
				</UiButton>
			</div>
			<UiAlert v-if="discoverError" tone="error">{{ discoverError }}</UiAlert>

			<div class="grid gap-3 sm:grid-cols-2">
				<UiFormField v-if="workspaces.length > 1" v-slot="f" label="Workspace">
					<UiSelect :id="f.id" v-model="workspaceId" class="w-full" @change="onWorkspaceChange">
						<option value="" disabled>Choose a workspace</option>
						<option v-for="ws in workspaces" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
					</UiSelect>
				</UiFormField>
				<UiFormField v-slot="f" label="Kaneo project">
					<UiSelect
						:id="f.id"
						v-model="kaneoProjectId"
						class="w-full"
						:disabled="projects.length === 0"
						@change="onProjectChange"
					>
						<option value="" disabled>Choose a project</option>
						<option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }} ({{ p.slug }})</option>
					</UiSelect>
				</UiFormField>
			</div>

			<div v-if="columns.length" class="grid gap-3 sm:grid-cols-3">
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
						<UiInput
							:id="f.id"
							v-model="environments"
							:aria-describedby="f.describedBy"
							placeholder="production"
						/>
					</UiFormField>
				</div>
			</div>

			<div class="flex flex-wrap gap-2">
				<UiButton type="submit" variant="primary" :icon="PlugZap" :loading="saving" :disabled="!canSave">
					{{ connected ? 'Save' : 'Connect' }}
				</UiButton>
				<UiButton v-if="connected" :loading="testing" @click="test">Test connection</UiButton>
				<UiButton v-if="connected" variant="danger" :icon="Unplug" @click="disconnect">Disconnect</UiButton>
			</div>
		</form>
	</UiCard>
</template>
