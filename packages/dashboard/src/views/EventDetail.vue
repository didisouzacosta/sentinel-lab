<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import AttachmentList from '../components/AttachmentList.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import { UiAlert, UiButton, UiCode, UiSkeleton } from '../components/ui';

const route = useRoute();
const slug = computed(() => route.params.slug as string);
const eventId = computed(() => route.params.eventId as string);

const event = ref<Record<string, unknown> | null>(null);
const issueId = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function loadEvent() {
	loading.value = true;
	error.value = null;

	try {
		const response = await api.get<{ event: Record<string, unknown>; issueId: string }>(
			`/api/projects/${slug.value}/events/${eventId.value}`,
		);
		event.value = response.event;
		issueId.value = response.issueId;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load event';
	} finally {
		loading.value = false;
	}
}

onMounted(() => loadEvent());
</script>

<template>
	<div class="flex flex-col gap-5">
		<UiSkeleton v-if="loading" variant="block" label="Loading event" class="h-80" />

		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadEvent">{{ error }}</UiAlert>

		<template v-else-if="event">
			<AppPageHeader title="Event">
				<template #subtitle><span class="font-mono">{{ eventId }}</span></template>
				<template #actions>
					<UiButton v-if="issueId" :to="`/projects/${slug}/issues/${issueId}`" :icon="ArrowLeft">Back to issue</UiButton>
				</template>
			</AppPageHeader>

			<UiCode language="Raw event (JSON)" :code="JSON.stringify(event, null, 2)" />

			<AttachmentList :slug="slug" :event-id="eventId" />
		</template>
	</div>
</template>
