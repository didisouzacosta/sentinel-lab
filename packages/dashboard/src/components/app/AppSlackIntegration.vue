<script setup lang="ts">
// Slack setup for one project, as three steps (owner/admin only; the page
// renders it only for managers and the server enforces the same rule):
//   1. create the Slack app from Sentinel's manifest (and tell us its page),
//   2. install it and paste the bot token → Verify & save (stored as pending),
//   3. choose the channel and alerts → connected.
// The bot token is write-only: the API returns it masked.
import { RefreshCw, Send, Unplug } from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { parseSlackAppId, slackLinks } from '../../lib/integration-links';
import {
	environmentsPhrase,
	LEVELS,
	levelPhrase,
	type SlackIntegration,
	slackSummary,
	splitEnvironments,
} from '../../lib/integrations';
import {
	UiAlert,
	UiButton,
	UiCode,
	UiExternalLink,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiSwitch,
} from '../ui';
import AppConnectionHeader from './AppConnectionHeader.vue';
import AppSetupStep from './AppSetupStep.vue';

interface Channel {
	id: string;
	name: string;
	isPrivate: boolean;
	isMember: boolean;
}

type Step = 1 | 2 | 3;

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ change: [integration: SlackIntegration | null] }>();

const toast = useToast();
const askConfirm = useConfirm();

const loading = ref(true);
const loadError = ref<string | null>(null);
const configured = ref(true);
const integration = ref<SlackIntegration | null>(null);
const manifest = ref<unknown>(null);

// Step 1
const appPage = ref('');
const appPageError = ref<string | null>(null);
/** App ID known before the token is saved (sent with it). */
const localAppId = ref<string | null>(null);
const skippedApp = ref(false);
const savingApp = ref(false);
// Step 2
const botToken = ref('');
const tokenError = ref<string | null>(null);
const verifying = ref(false);
// Step 3
const channelId = ref('');
const minLevel = ref('error');
const environments = ref('');
const notifyRegression = ref(true);
const notifyResolved = ref(true);
const channels = ref<Channel[]>([]);
const truncated = ref(false);
const discovering = ref(false);
const discoverError = ref<string | null>(null);
const saving = ref(false);
const testing = ref(false);
/** A finished step reopened with Change. */
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

const base = computed(() => `/api/projects/${props.slug}/integrations/slack`);
const summary = computed(() => slackSummary(integration.value));
const appId = computed(() => integration.value?.appId ?? localAppId.value);
const connected = computed(() => integration.value?.status === 'connected');
const tokenSaved = computed(
	() => Boolean(integration.value) && integration.value?.credentialsReadable === true,
);

const done = computed<Record<Step, boolean>>(() => ({
	1: Boolean(integration.value) || Boolean(localAppId.value) || skippedApp.value,
	2: tokenSaved.value,
	3: connected.value,
}));
const firstOpen = computed<Step | null>(
	() => ([1, 2, 3] as Step[]).find((step) => !done.value[step]) ?? null,
);
function stateOf(step: Step): 'current' | 'done' | 'locked' {
	if (editing.value === step) return 'current';
	if (done.value[step]) return 'done';
	return firstOpen.value === step && editing.value === null ? 'current' : 'locked';
}

const appSummary = computed(() =>
	appId.value ? `App ${appId.value}` : 'Created in Slack (app page not linked)',
);
const tokenSummary = computed(() => {
	const value = integration.value;
	if (!value) return '';
	const parts = ['Verified', `workspace ${value.teamName}`];
	if (value.botToken) parts.push(`token ${value.botToken}`);
	return parts.join(' · ');
});
const channelSummary = computed(() => {
	const value = integration.value;
	if (!value || value.status !== 'connected') return '';
	const extras = [
		value.notifyRegression ? 'regressions on' : 'regressions off',
		value.notifyResolved ? 'resolutions on' : 'resolutions off',
	];
	return [
		`#${value.channelName}`,
		levelPhrase(value.minLevel),
		environmentsPhrase(value.environments),
		...extras,
	].join(' · ');
});
const manifestJson = computed(() =>
	manifest.value ? JSON.stringify(manifest.value, null, 2) : '',
);

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function setIntegration(value: SlackIntegration | null) {
	integration.value = value;
	emit('change', value);
	if (!value) return;
	channelId.value = value.channelId;
	minLevel.value = value.minLevel;
	environments.value = value.environments.join(', ');
	notifyRegression.value = value.notifyRegression;
	notifyResolved.value = value.notifyResolved;
	if (value.channelId && !channels.value.some((channel) => channel.id === value.channelId)) {
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

async function focusStep(step: Step) {
	await nextTick();
	stepRefs.value[step]?.focus();
}

/** Channels the saved token can post to. */
async function discover() {
	discovering.value = true;
	discoverError.value = null;
	try {
		const result = await api.post<{ channels: Channel[]; truncated: boolean }>(
			`${base.value}/discover`,
			{},
		);
		channels.value = result.channels;
		truncated.value = result.truncated;
		if (!channels.value.some((channel) => channel.id === channelId.value)) channelId.value = '';
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
		manifest.value = result.manifest;
		setIntegration(result.integration);
		if (result.integration?.status === 'pending' && result.integration.credentialsReadable) {
			discover();
		}
	} catch (err) {
		loadError.value = message(err, 'Failed to load the Slack integration');
	} finally {
		loading.value = false;
	}
}

async function saveApp() {
	appPageError.value = null;
	const parsed = parseSlackAppId(appPage.value);
	if (!parsed) {
		appPageError.value = appPage.value.trim()
			? 'That does not look like a Slack app page or App ID (it looks like A08K2TX4R1Q).'
			: "Paste your app's page address, or choose “I already have a token”.";
		return;
	}
	if (integration.value) {
		savingApp.value = true;
		try {
			const result = await api.put<{ integration: SlackIntegration }>(base.value, {
				appId: parsed,
			});
			setIntegration(result.integration);
		} catch (err) {
			appPageError.value = message(err, 'Failed to save the app page');
			return;
		} finally {
			savingApp.value = false;
		}
	} else {
		localAppId.value = parsed;
	}
	appPage.value = '';
	editing.value = null;
	focusStep(tokenSaved.value ? 3 : 2);
}

function skipApp() {
	skippedApp.value = true;
	appPageError.value = null;
	editing.value = null;
	focusStep(2);
}

async function verifyToken() {
	tokenError.value = null;
	if (!botToken.value.trim()) {
		tokenError.value = 'Paste the Bot User OAuth Token (it starts with xoxb-).';
		return;
	}
	verifying.value = true;
	try {
		const body: Record<string, unknown> = { botToken: botToken.value.trim() };
		if (!integration.value && localAppId.value) body.appId = localAppId.value;
		const result = await api.put<{ integration: SlackIntegration }>(base.value, body);
		setIntegration(result.integration);
		botToken.value = '';
		editing.value = null;
		toast.success(`Token verified · workspace ${result.integration.teamName}`);
		if (result.integration.status === 'pending') {
			focusStep(3);
			discover();
		}
	} catch (err) {
		tokenError.value = message(err, 'Slack refused this token');
	} finally {
		verifying.value = false;
	}
}

async function saveChannel() {
	if (!channelId.value) return;
	saving.value = true;
	try {
		const wasConnected = connected.value;
		const result = await api.put<{ integration: SlackIntegration }>(base.value, {
			channelId: channelId.value,
			minLevel: minLevel.value,
			environments: splitEnvironments(environments.value),
			notifyRegression: notifyRegression.value,
			notifyResolved: notifyResolved.value,
		});
		setIntegration(result.integration);
		editing.value = null;
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

function change(step: Step) {
	editing.value = step;
	if (step === 1) appPage.value = appId.value ?? '';
	if (step === 3) discover();
	focusStep(step);
}

function cancelChange() {
	editing.value = null;
	appPageError.value = null;
	tokenError.value = null;
	botToken.value = '';
	if (integration.value) setIntegration(integration.value);
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
			'Sentinel stops posting to Slack for this project, forgets the bot token and which message belongs to which issue. Messages already in Slack stay there.',
		confirmLabel: 'Disconnect',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(base.value);
		setIntegration(null);
		channels.value = [];
		channelId.value = '';
		localAppId.value = null;
		skippedApp.value = false;
		editing.value = null;
		toast.success('Slack disconnected');
	} catch (err) {
		toast.error(message(err, 'Failed to disconnect Slack'));
	}
}

onMounted(load);
</script>

<template>
	<div class="flex flex-col gap-4" data-testid="slack-integration">
		<UiSkeleton v-if="loading" variant="block" class="h-40" label="Loading the Slack integration" />
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<UiAlert v-else-if="!configured" tone="warning">
			Integrations are off on this Sentinel instance: the <code>INTEGRATIONS_KEY</code> secret is not set.
		</UiAlert>
		<template v-else>
			<AppConnectionHeader
				:state="summary.state"
				:title="summary.title"
				:summary="integration ? (connected ? channelSummary : summary.summary) : 'Three steps, about two minutes. Nothing is posted until you pick a channel.'"
			>
				<template v-if="integration" #actions>
					<UiButton v-if="connected" size="sm" :icon="Send" :loading="testing" @click="test">Send test</UiButton>
					<UiButton size="sm" variant="danger" :icon="Unplug" @click="disconnect">Disconnect</UiButton>
				</template>
			</AppConnectionHeader>

			<UiAlert v-if="integration?.lastError" tone="error">
				Last delivery failed: {{ integration.lastError }}
			</UiAlert>

			<ol class="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface" aria-label="Slack setup steps">
				<AppSetupStep
					:ref="stepRef(1)"
					:number="1"
					title="Create the Slack app"
					:state="stateOf(1)"
					:description="stateOf(1) === 'done' ? appSummary : 'Sentinel fills in the name, the bot user and the four permissions it needs.'"
					data-testid="slack-step-app"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(1)">Change</UiButton>
					</template>
					<div class="flex flex-wrap items-center gap-3">
						<UiExternalLink variant="button" :href="slackLinks.createApp(manifest)" data-testid="slack-create-app">
							Create the app in Slack
						</UiExternalLink>
						<details v-if="manifestJson" class="text-body-s text-fg-muted">
							<summary class="cursor-pointer">Or paste the manifest yourself</summary>
							<p class="mt-2 text-caption text-fg-subtle">Create New App → From a manifest, then paste:</p>
							<UiCode class="mt-2" :code="manifestJson" language="App manifest (JSON)" />
						</details>
					</div>
					<form class="flex flex-col gap-3" @submit.prevent="saveApp">
						<UiFormField
							v-slot="f"
							label="Your app's page"
							:error="appPageError"
							help="After creating the app, paste the address of its page (api.slack.com/apps/A…) or its App ID. We use it to link you straight to the token."
						>
							<UiInput
								:id="f.id"
								v-model="appPage"
								:aria-describedby="f.describedBy"
								:aria-invalid="f.invalid || undefined"
								autocomplete="off"
								placeholder="https://api.slack.com/apps/A0…"
								data-testid="slack-app-page"
							/>
						</UiFormField>
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :loading="savingApp">Continue</UiButton>
							<UiButton v-if="!integration" variant="ghost" @click="skipApp">I already have a token</UiButton>
							<UiButton v-if="editing === 1" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>

				<AppSetupStep
					:ref="stepRef(2)"
					:number="2"
					title="Install the app and paste the bot token"
					:state="stateOf(2)"
					:description="stateOf(2) === 'done' ? tokenSummary : 'Two clicks in Slack, then paste the token here. Sentinel never reads it from Slack for you.'"
					locked-hint="Complete step 1 first"
					data-testid="slack-step-token"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(2)">Change</UiButton>
					</template>
					<ol class="flex flex-col gap-2.5">
						<li class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
							<span class="flex size-5 items-center justify-center rounded-full bg-subtle text-caption text-fg-muted">a</span>
							<span class="text-body-s text-fg">Install the app in your workspace</span>
							<UiExternalLink :href="slackLinks.install(appId)" data-testid="slack-install-link">Install to Workspace</UiExternalLink>
						</li>
						<li class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
							<span class="flex size-5 items-center justify-center rounded-full bg-subtle text-caption text-fg-muted">b</span>
							<span class="text-body-s text-fg">Copy the <strong>Bot User OAuth Token</strong> (starts with <code>xoxb-</code>)</span>
							<UiExternalLink :href="slackLinks.oauth(appId)" data-testid="slack-oauth-link">Open OAuth &amp; Permissions</UiExternalLink>
						</li>
					</ol>
					<p v-if="!appId" class="text-caption text-fg-subtle">
						Without the app page, these open your list of Slack apps: pick the app first.
					</p>
					<form class="flex flex-col gap-3" @submit.prevent="verifyToken">
						<UiFormField
							v-slot="f"
							label="Bot token"
							:error="tokenError"
							:help="integration?.botToken ? `Saved (${integration.botToken}). Paste a new one to replace it.` : 'Paste it here. We check it with Slack and save it encrypted before you pick a channel.'"
						>
							<UiInput
								:id="f.id"
								v-model="botToken"
								:aria-describedby="f.describedBy"
								:aria-invalid="f.invalid || undefined"
								type="password"
								autocomplete="off"
								:placeholder="integration?.botToken ?? 'xoxb-…'"
								data-testid="slack-token"
							/>
						</UiFormField>
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :loading="verifying">Verify &amp; save</UiButton>
							<UiButton v-if="editing === 2" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>

				<AppSetupStep
					:ref="stepRef(3)"
					:number="3"
					title="Choose the channel and alerts"
					:state="stateOf(3)"
					:description="stateOf(3) === 'done' ? channelSummary : 'Pick where alerts go and which ones are worth a message.'"
					locked-hint="Complete step 2 first"
					data-testid="slack-step-channel"
				>
					<template #actions>
						<UiButton size="sm" variant="ghost" @click="change(3)">Change</UiButton>
					</template>
					<form class="flex flex-col gap-3" @submit.prevent="saveChannel">
						<div v-if="discovering" class="flex flex-col gap-2" data-testid="slack-channels-loading">
							<p class="flex items-center gap-2 text-body-s font-medium text-fg-muted">
								<RefreshCw :size="14" class="animate-spin" aria-hidden="true" />
								Loading channels from Slack…
							</p>
							<UiSkeleton variant="line" :count="2" label="Loading channels from Slack" />
						</div>
						<UiAlert v-else-if="discoverError" tone="error" action-label="Try again" @action="discover">
							{{ discoverError }}
						</UiAlert>
						<UiFormField
							v-else
							v-slot="f"
							label="Channel"
							:help="truncated ? 'Showing the first 1000 channels.' : 'Private channels show up once the bot is invited (/invite @Sentinel).'"
						>
							<div class="flex flex-wrap items-center gap-2">
								<UiSelect :id="f.id" v-model="channelId" class="min-w-0 flex-1" data-testid="slack-channel">
									<option value="" disabled>Choose a channel</option>
									<option v-for="channel in channels" :key="channel.id" :value="channel.id">
										{{ channel.isPrivate ? '🔒' : '#' }}{{ channel.name }}
									</option>
								</UiSelect>
								<UiButton :icon="RefreshCw" @click="discover">Reload channels</UiButton>
							</div>
						</UiFormField>
						<div :class="['grid gap-3 sm:grid-cols-2', !channelId && 'opacity-50']">
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
						<div class="flex flex-wrap items-center gap-2">
							<UiButton type="submit" variant="primary" :loading="saving" :disabled="!channelId">
								{{ connected ? 'Save' : 'Save and connect' }}
							</UiButton>
							<UiButton v-if="editing === 3" variant="ghost" @click="cancelChange">Cancel</UiButton>
						</div>
					</form>
				</AppSetupStep>
			</ol>
		</template>
	</div>
</template>
