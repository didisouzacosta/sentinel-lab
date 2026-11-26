<script setup lang="ts">
// Integrations overview: one card per integration with its status.
// Slack and Kaneo statuses are owner/admin only (as their API is); members
// see what each integration does and who sets it up.
import { Slack, SquareKanban, Webhook } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import AppIntegrationCard from '../components/app/AppIntegrationCard.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import { UiAlert, UiSkeleton } from '../components/ui';
import {
	type KaneoIntegration,
	kaneoSummary,
	type SlackIntegration,
	slackSummary,
	webhookSummary,
} from '../lib/integrations';
import { useProjectsStore } from '../stores/projects';

const route = useRoute();
const projectsStore = useProjectsStore();
const slug = computed(() => route.params.slug as string);
const canManage = computed(() => projectsStore.canManage(slug.value));

const loading = ref(true);
const loadError = ref<string | null>(null);
const configured = ref(true);
const slack = ref<SlackIntegration | null>(null);
const kaneo = ref<KaneoIntegration | null>(null);
const webhookUrl = ref<string | null>(null);

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

async function load() {
	loading.value = true;
	loadError.value = null;
	try {
		const project = api.get<{ project: { webhookUrl?: string | null } }>(
			`/api/projects/${slug.value}`,
		);
		if (canManage.value) {
			const [p, s, k] = await Promise.all([
				project,
				api.get<{ configured: boolean; integration: SlackIntegration | null }>(
					`/api/projects/${slug.value}/integrations/slack`,
				),
				api.get<{ configured: boolean; integration: KaneoIntegration | null }>(
					`/api/projects/${slug.value}/integrations/kaneo`,
				),
			]);
			webhookUrl.value = p.project.webhookUrl || null;
			slack.value = s.integration;
			kaneo.value = k.integration;
			configured.value = k.configured;
		} else {
			webhookUrl.value = (await project).project.webhookUrl || null;
		}
	} catch (err) {
		loadError.value = message(err, 'Failed to load the integrations');
	} finally {
		loading.value = false;
	}
}

function actionFor(state: string, needsKey: boolean) {
	if (needsKey && !configured.value) return undefined;
	if (state === 'off') return { label: 'Set up', variant: 'primary' as const };
	if (state === 'pending') return { label: 'Continue', variant: 'primary' as const };
	if (state === 'attention') return { label: 'Fix', variant: 'secondary' as const };
	return { label: 'Manage', variant: 'secondary' as const };
}

const cards = computed(() => {
	const base = `/projects/${slug.value}/integrations`;
	const s = slackSummary(slack.value);
	const k = kaneoSummary(kaneo.value);
	const w = webhookSummary(webhookUrl.value);
	const list = [
		{
			key: 'slack',
			name: 'Slack',
			description: 'Post new issues, regressions and resolutions to a channel.',
			icon: Slack,
			summary: s,
			needsKey: true,
		},
		{
			key: 'kaneo',
			name: 'Kaneo',
			description: 'Turn issues into tasks and keep both sides in sync.',
			icon: SquareKanban,
			summary: k,
			needsKey: true,
		},
		{
			key: 'webhook',
			name: 'Webhook',
			description: 'Send issue alerts to any URL — Discord or your own endpoint.',
			icon: Webhook,
			summary: w,
			needsKey: false,
		},
	];
	return list.map((card) => {
		const visible = canManage.value || card.key === 'webhook';
		const action = canManage.value ? actionFor(card.summary.state, card.needsKey) : undefined;
		return {
			...card,
			state: visible && !(card.needsKey && !configured.value) ? card.summary.state : undefined,
			text: !visible
				? 'Set up by project owners and admins'
				: card.needsKey && !configured.value
					? 'Needs INTEGRATIONS_KEY on the server'
					: card.summary.summary,
			to: action ? `${base}/${card.key}` : undefined,
			action,
		};
	});
});

onMounted(load);
watch(slug, load);
</script>

<template>
	<div class="flex flex-col gap-5">
		<AppPageHeader title="Integrations" subtitle="Send issues to the tools your team already uses." />

		<UiAlert v-if="!canManage" tone="info">
			Only project owners and admins can set up integrations.
		</UiAlert>
		<UiAlert v-else-if="!loading && !configured" tone="warning" data-testid="integrations-unconfigured">
			Slack and Kaneo are off on this Sentinel instance: the <code>INTEGRATIONS_KEY</code> secret is not set.
			The webhook still works.
		</UiAlert>

		<div v-if="loading" class="grid gap-4 md:grid-cols-3">
			<UiSkeleton v-for="i in 3" :key="i" variant="block" class="h-40" label="Loading integrations" />
		</div>
		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="load">{{ loadError }}</UiAlert>
		<ul v-else class="grid items-stretch gap-4 md:grid-cols-3" data-testid="integration-cards">
			<li v-for="card in cards" :key="card.key" :data-testid="`integration-${card.key}`">
				<AppIntegrationCard
					:name="card.name"
					:description="card.description"
					:icon="card.icon"
					:state="card.state"
					:summary="card.text"
					:to="card.to"
					:action-label="card.action?.label"
					:action-variant="card.action?.variant"
				/>
			</li>
		</ul>

		<UiAlert v-if="!loading && !loadError" tone="info">
			Slack and Kaneo work independently — set up either one, or both. Two-way sync with Kaneo also needs the
			project webhook, and Kaneo allows one per project.
		</UiAlert>
	</div>
</template>
