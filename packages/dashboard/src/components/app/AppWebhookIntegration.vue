<script setup lang="ts">
// Generic webhook for one project: Sentinel POSTs a JSON payload for new
// issues and regressions (Discord or any HTTP endpoint). Owner/admin only.
import { Send, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { webhookSummary } from '../../lib/integrations';
import { UiAlert, UiButton, UiCard, UiFormField, UiInput, UiSkeleton } from '../ui';
import AppConnectionHeader from './AppConnectionHeader.vue';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ change: [url: string | null] }>();

const toast = useToast();
const askConfirm = useConfirm();

const loading = ref(true);
const loadError = ref<string | null>(null);
const savedUrl = ref<string | null>(null);
const url = ref('');
const saving = ref(false);
const testing = ref(false);

const summary = computed(() => webhookSummary(savedUrl.value));

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		const result = await api.get<{ project: { webhookUrl?: string | null } }>(
			`/api/projects/${props.slug}`,
		);
		savedUrl.value = result.project.webhookUrl || null;
		url.value = savedUrl.value ?? '';
	} catch (err) {
		loadError.value = message(err, 'Failed to load the webhook');
	} finally {
		loading.value = false;
	}
}

async function persist(value: string | null) {
	await api.patch(`/api/projects/${props.slug}`, { webhookUrl: value });
	savedUrl.value = value;
	url.value = value ?? '';
	emit('change', value);
}

async function save() {
	saving.value = true;
	try {
		await persist(url.value.trim() || null);
		toast.success(url.value ? 'Webhook saved' : 'Webhook removed');
	} catch (err) {
		toast.error(message(err, 'Failed to save webhook'));
	} finally {
		saving.value = false;
	}
}

async function test() {
	testing.value = true;
	try {
		await api.post(`/api/projects/${props.slug}/test-webhook`, {});
		toast.success('Test notification sent');
	} catch (err) {
		toast.error(message(err, 'Failed to send test webhook. Check the URL and try again.'));
	} finally {
		testing.value = false;
	}
}

async function remove() {
	const ok = await askConfirm({
		title: 'Remove the webhook?',
		description: 'Sentinel stops sending issue alerts to this URL.',
		confirmLabel: 'Remove',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await persist(null);
		toast.success('Webhook removed');
	} catch (err) {
		toast.error(message(err, 'Failed to remove the webhook'));
	}
}

onMounted(load);
</script>

<template>
	<div class="flex flex-col gap-4" data-testid="webhook-integration">
		<UiSkeleton v-if="loading" variant="block" class="h-40" label="Loading the webhook" />
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<template v-else>
			<AppConnectionHeader :state="summary.state" :title="summary.title" :summary="savedUrl ? summary.summary : 'Paste a URL and Sentinel POSTs a JSON payload for each new issue and regression.'" />
			<UiCard title="Webhook URL" meta="We POST a JSON payload" padded>
				<form class="flex flex-col gap-3" @submit.prevent="save">
					<UiFormField
						v-slot="f"
						label="URL"
						help="Examples: a Discord channel webhook, or your own endpoint that accepts JSON. For Slack, use the Slack integration."
					>
						<UiInput
							:id="f.id"
							v-model="url"
							:aria-describedby="f.describedBy"
							type="url"
							placeholder="https://discord.com/api/webhooks/..."
							data-testid="webhook-url"
						/>
					</UiFormField>
					<div class="flex flex-wrap gap-2">
						<UiButton type="submit" variant="primary" :loading="saving">Save</UiButton>
						<UiButton v-if="savedUrl" :icon="Send" :loading="testing" @click="test">Send test</UiButton>
						<UiButton v-if="savedUrl" variant="ghost" :icon="Trash2" @click="remove">Remove</UiButton>
					</div>
				</form>
			</UiCard>
		</template>
	</div>
</template>
