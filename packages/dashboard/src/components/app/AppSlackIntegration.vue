<script setup lang="ts">
// Slack integration settings for one project (owner/admin only; the parent
// renders it only for managers and the server enforces the same rule).
// The bot token is write-only here: the API returns it masked, and the input
// starts empty with the masked value as a hint.
import { ExternalLink, PlugZap, RefreshCw, Send, Unplug } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiCode,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiSwitch,
} from '../ui';

export interface SlackIntegration {
	id: string;
	enabled: boolean;
	teamId: string;
	teamName: string;
	channelId: string;
	channelName: string;
	channelPrivate: boolean;
	minLevel: string;
	environments: string[];
	notifyRegression: boolean;
	notifyResolved: boolean;
	botToken: string | null;
	credentialsReadable: boolean;
	lastError: string | null;
	lastErrorAt: string | null;
}

interface Channel {
	id: string;
	name: string;
	isPrivate: boolean;
	isMember: boolean;
}

const props = defineProps<{ slug: string }>();

const toast = useToast();
const askConfirm = useConfirm();

const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];

const loading = ref(true);
const loadError = ref<string | null>(null);
const configured = ref(true);
const integration = ref<SlackIntegration | null>(null);
const manifest = ref<unknown>(null);

// Form state
const botToken = ref('');
const channelId = ref('');
const minLevel = ref('error');
const environments = ref('');
const notifyRegression = ref(true);
const notifyResolved = ref(true);

const channels = ref<Channel[]>([]);
const teamName = ref('');
const truncated = ref(false);
const discovering = ref(false);
const discoverError = ref<string | null>(null);
const saving = ref(false);
const testing = ref(false);

const base = computed(() => `/api/projects/${props.slug}/integrations/slack`);
const connected = computed(() => integration.value !== null);
const canSave = computed(
	() => Boolean(channelId.value) && (connected.value || Boolean(botToken.value)),
);
const manifestJson = computed(() =>
	manifest.value ? JSON.stringify(manifest.value, null, 2) : '',
);
/** Slack's documented "create an app from this manifest" link. */
const createAppUrl = computed(() =>
	manifest.value
		? `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest.value))}`
		: 'https://api.slack.com/apps?new_app=1',
);

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function fillForm(value: SlackIntegration) {
	channelId.value = value.channelId;
	minLevel.value = value.minLevel;
	environments.value = value.environments.join(', ');
	notifyRegression.value = value.notifyRegression;
	notifyResolved.value = value.notifyResolved;
	teamName.value = value.teamName;
	botToken.value = '';
	// The saved channel shows even before the picker loads.
	if (!channels.value.some((channel) => channel.id === value.channelId)) {
		channels.value = [
			{
				id: value.channelId,
				name: value.channelName,
				isPrivate: value.channelPrivate,
				isMember: true,
			},
			...channels.value,
		];
	}
}

/** Ask the server which channels this token can post to (falls back to the saved one). */
async function discover() {
	discovering.value = true;
	discoverError.value = null;
	try {
		const result = await api.post<{
			team: { name: string };
			channels: Channel[];
			truncated: boolean;
		}>(`${base.value}/discover`, botToken.value ? { botToken: botToken.value } : {});
		teamName.value = result.team.name;
		channels.value = result.channels;
		truncated.value = result.truncated;
		if (!channels.value.some((channel) => channel.id === channelId.value)) {
			channelId.value = '';
		}
	} catch (err) {
		discoverError.value = message(err, 'Could not reach Slack');
	} finally {
		discovering.value = false;
	}
}

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		const result = await api.get<{
			configured: boolean;
			integration: SlackIntegration | null;
			manifest: unknown;
		}>(base.value);
		configured.value = result.configured;
		integration.value = result.integration;
		manifest.value = result.manifest;
		if (result.integration) fillForm(result.integration);
	} catch (err) {
		loadError.value = message(err, 'Failed to load the Slack integration');
	} finally {
		loading.value = false;
	}
}

async function save() {
	saving.value = true;
	try {
		const body: Record<string, unknown> = {
			channelId: channelId.value,
			minLevel: minLevel.value,
			environments: environments.value
				.split(',')
				.map((name) => name.trim())
				.filter(Boolean),
			notifyRegression: notifyRegression.value,
			notifyResolved: notifyResolved.value,
		};
		if (botToken.value) body.botToken = botToken.value;
		const result = await api.put<{ integration: SlackIntegration }>(base.value, body);
		const wasConnected = connected.value;
		integration.value = result.integration;
		fillForm(result.integration);
		toast.success(
			wasConnected
				? 'Slack settings saved'
				: `Slack connected to #${result.integration.channelName}`,
		);
	} catch (err) {
		toast.error(message(err, 'Failed to save the Slack settings'));
	} finally {
		saving.value = false;
	}
}

async function test() {
	testing.value = true;
	try {
		const result = await api.post<{ channel: { name: string } }>(`${base.value}/test`, {});
		toast.success(`Test message posted to #${result.channel.name}`);
	} catch (err) {
		toast.error(message(err, 'Slack test failed'));
	} finally {
		testing.value = false;
	}
}

async function disconnect() {
	const ok = await askConfirm({
		title: 'Disconnect Slack?',
		description:
			'Sentinel stops posting to Slack for this project and forgets which message belongs to which issue. Messages already in Slack stay there.',
		confirmLabel: 'Disconnect',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(base.value);
		integration.value = null;
		channels.value = [];
		channelId.value = '';
		teamName.value = '';
		toast.success('Slack disconnected');
	} catch (err) {
		toast.error(message(err, 'Failed to disconnect Slack'));
	}
}

onMounted(load);
</script>

<template>
	<UiCard
		id="slack"
		title="Slack"
		:meta="connected ? `#${integration?.channelName}` : 'Not connected'"
		class="scroll-mt-20"
		padded
	>
		<UiSkeleton v-if="loading" class="h-24 w-full" />
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<UiAlert v-else-if="!configured" tone="warning">
			Integrations are off on this Sentinel instance: the <code>INTEGRATIONS_KEY</code> secret is not set.
		</UiAlert>
		<form v-else class="flex flex-col gap-4" data-testid="slack-form" @submit.prevent="save">
			<p class="text-body-s text-fg-muted">
				Post a message to a Slack channel for each new issue, reply in its thread when a resolved error comes
				back, and mark it resolved when you resolve the issue.
			</p>

			<UiAlert v-if="integration?.lastError" tone="error">
				Last delivery failed: {{ integration.lastError }}
			</UiAlert>
			<UiAlert v-if="integration && !integration.credentialsReadable" tone="warning">
				The saved token can no longer be read. Paste the bot token again.
			</UiAlert>

			<details v-if="!connected" class="rounded-lg border border-border px-3.5 py-3" open data-testid="slack-setup">
				<summary class="cursor-pointer text-body-s font-medium text-fg">1. Create the Slack app</summary>
				<div class="mt-3 flex flex-col gap-3">
					<p class="text-body-s text-fg-muted">
						Open Slack's app builder with Sentinel's manifest filled in, pick your workspace, create the app and
						click <strong>Install to Workspace</strong>. Then copy the
						<strong>Bot User OAuth Token</strong> (OAuth &amp; Permissions, starts with <code>xoxb-</code>).
					</p>
					<a
						:href="createAppUrl"
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1.5 self-start text-body-s font-medium text-accent-text hover:underline"
						data-testid="slack-create-app"
					>
						Create the app in Slack
						<ExternalLink :size="14" aria-hidden="true" />
					</a>
					<details v-if="manifestJson">
						<summary class="cursor-pointer text-caption text-fg-subtle">Or paste the manifest yourself (Create New App → From a manifest)</summary>
						<UiCode class="mt-2" :code="manifestJson" language="App manifest (JSON)" />
					</details>
				</div>
			</details>

			<UiFormField
				v-slot="f"
				:label="connected ? 'Bot token' : '2. Bot token'"
				:help="integration?.botToken ? `Saved (${integration.botToken}). Paste a new one to replace it.` : 'Bot User OAuth Token, starts with xoxb-.'"
			>
				<UiInput
					:id="f.id"
					v-model="botToken"
					:aria-describedby="f.describedBy"
					type="password"
					autocomplete="off"
					:placeholder="integration?.botToken ?? 'xoxb-…'"
				/>
			</UiFormField>

			<div class="flex flex-wrap items-center gap-2">
				<UiButton :icon="RefreshCw" :loading="discovering" :disabled="!connected && !botToken" @click="discover">
					{{ channels.length > 1 ? 'Reload channels' : 'Load channels' }}
				</UiButton>
				<span v-if="teamName" class="text-caption text-fg-subtle">Workspace: {{ teamName }}</span>
			</div>
			<UiAlert v-if="discoverError" tone="error">{{ discoverError }}</UiAlert>

			<UiFormField
				v-slot="f"
				:label="connected ? 'Channel' : '3. Channel'"
				:help="truncated ? 'Showing the first 1000 channels.' : 'Private channels show up once the bot is invited (/invite @Sentinel).'"
			>
				<UiSelect :id="f.id" v-model="channelId" class="w-full" :disabled="channels.length === 0">
					<option value="" disabled>Choose a channel</option>
					<option v-for="channel in channels" :key="channel.id" :value="channel.id">
						{{ channel.isPrivate ? '🔒' : '#' }}{{ channel.name }}
					</option>
				</UiSelect>
			</UiFormField>

			<div class="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3">
				<div class="grid gap-3 sm:grid-cols-2">
					<UiFormField v-slot="f" label="Minimum level">
						<UiSelect :id="f.id" v-model="minLevel" class="w-full">
							<option v-for="level in LEVELS" :key="level" :value="level">{{ level }}</option>
						</UiSelect>
					</UiFormField>
					<UiFormField v-slot="f" label="Environments" help="Comma-separated. Empty means all.">
						<UiInput :id="f.id" v-model="environments" :aria-describedby="f.describedBy" placeholder="production" />
					</UiFormField>
				</div>
				<div class="flex items-center justify-between gap-3">
					<div>
						<p class="text-body-s font-medium text-fg">Errors that come back</p>
						<p class="text-caption text-fg-subtle">Reply in the thread when a resolved issue gets events again.</p>
					</div>
					<UiSwitch v-model="notifyRegression" label="Errors that come back" />
				</div>
				<div class="flex items-center justify-between gap-3">
					<div>
						<p class="text-body-s font-medium text-fg">Resolutions</p>
						<p class="text-caption text-fg-subtle">Mark the message resolved when the issue is resolved.</p>
					</div>
					<UiSwitch v-model="notifyResolved" label="Resolutions" />
				</div>
			</div>

			<div class="flex flex-wrap gap-2">
				<UiButton type="submit" variant="primary" :icon="PlugZap" :loading="saving" :disabled="!canSave">
					{{ connected ? 'Save' : 'Connect' }}
				</UiButton>
				<UiButton v-if="connected" :icon="Send" :loading="testing" @click="test">Send test message</UiButton>
				<UiButton v-if="connected" variant="danger" :icon="Unplug" @click="disconnect">Disconnect</UiButton>
			</div>
		</form>
	</UiCard>
</template>
