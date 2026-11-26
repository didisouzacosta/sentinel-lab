<script setup lang="ts">
// One integration's page (Slack, Kaneo or Webhook): the guided setup steps.
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppKaneoIntegration from '../components/app/AppKaneoIntegration.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import AppSlackIntegration from '../components/app/AppSlackIntegration.vue';
import AppWebhookIntegration from '../components/app/AppWebhookIntegration.vue';
import { UiAlert } from '../components/ui';
import { useProjectsStore } from '../stores/projects';

const route = useRoute();
const projectsStore = useProjectsStore();
const slug = computed(() => route.params.slug as string);
const kind = computed(() => route.params.kind as 'slack' | 'kaneo' | 'webhook');
const canManage = computed(() => projectsStore.canManage(slug.value));

const PAGES = {
	slack: { title: 'Slack', subtitle: 'Post new issues, regressions and resolutions to a channel.' },
	kaneo: { title: 'Kaneo', subtitle: 'Turn issues into tasks and keep both sides in sync.' },
	webhook: {
		title: 'Webhook',
		subtitle: 'Send issue alerts to any URL — Discord or your own endpoint.',
	},
} as const;
const page = computed(() => PAGES[kind.value] ?? PAGES.webhook);
</script>

<template>
	<div class="mx-auto flex w-full max-w-3xl flex-col gap-5 lg:mx-0">
		<AppPageHeader :title="page.title" :subtitle="page.subtitle" />
		<UiAlert v-if="!canManage" tone="info">
			Only project owners and admins can set up {{ page.title }}.
		</UiAlert>
		<template v-else>
			<AppSlackIntegration v-if="kind === 'slack'" :key="`slack-${slug}`" :slug="slug" />
			<AppKaneoIntegration v-else-if="kind === 'kaneo'" :key="`kaneo-${slug}`" :slug="slug" />
			<AppWebhookIntegration v-else :key="`webhook-${slug}`" :slug="slug" />
		</template>
	</div>
</template>
