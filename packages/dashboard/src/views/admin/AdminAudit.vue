<script setup lang="ts">
import { ScrollText } from 'lucide-vue-next';
import { onMounted, ref } from 'vue';
import { api } from '../../api/client';
import AppPageHeader from '../../components/app/AppPageHeader.vue';
import { UiAlert, UiButton, UiCard, UiEmptyState, UiSkeleton, UiTag } from '../../components/ui';

interface AuditEntry {
	id: string;
	actorEmail: string;
	actorName: string;
	action: string;
	targetType: string;
	targetId: string | null;
	targetLabel: string | null;
	details: Record<string, unknown> | null;
	createdAt: string;
}

const entries = ref<AuditEntry[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);

async function load(cursor?: string) {
	error.value = null;
	try {
		const response = await api.get<{
			entries: AuditEntry[];
			nextCursor?: string;
			hasMore: boolean;
		}>(`/api/admin/audit?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
		if (cursor) {
			entries.value.push(...response.entries);
		} else {
			entries.value = response.entries;
		}
		nextCursor.value = response.nextCursor ?? null;
		hasMore.value = response.hasMore;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load audit log';
	} finally {
		loading.value = false;
		loadingMore.value = false;
	}
}

onMounted(() => load());

async function loadMore() {
	if (!nextCursor.value) return;
	loadingMore.value = true;
	await load(nextCursor.value);
}

function formatTime(value: string): string {
	return new Date(value).toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

function formatDetails(details: Record<string, unknown> | null): string {
	if (!details) return '';
	return JSON.stringify(details);
}
</script>

<template>
	<div class="flex flex-col gap-5">
		<AppPageHeader title="Audit log" subtitle="Every administrative action, newest first." />

		<UiSkeleton v-if="loading" :count="6" label="Loading audit log" />

		<UiAlert v-else-if="error && entries.length === 0" tone="error" action-label="Try again" @action="loading = true; load()">
			{{ error }}
		</UiAlert>

		<UiCard v-else>
			<table v-if="entries.length" class="w-full border-collapse text-left max-sm:block lg:table-fixed" data-testid="admin-audit-table">
				<caption class="sr-only">Audit log</caption>
				<thead class="max-sm:sr-only">
					<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
						<th scope="col" class="w-48 py-2 pl-4 font-semibold">Time</th>
						<th scope="col" class="w-52 py-2 pl-3 font-semibold">Actor</th>
						<th scope="col" class="w-48 py-2 pl-3 font-semibold">Action</th>
						<th scope="col" class="w-48 py-2 pl-3 font-semibold max-md:hidden">Target</th>
						<th scope="col" class="py-2 pr-4 pl-3 font-semibold max-lg:hidden">Details</th>
					</tr>
				</thead>
				<tbody class="max-sm:block">
					<tr
						v-for="entry in entries"
						:key="entry.id"
						class="border-b border-border align-top last:border-b-0 max-sm:flex max-sm:flex-col max-sm:gap-1 max-sm:px-4 max-sm:py-3"
					>
						<td class="py-2.5 pl-4 text-body-s text-fg-muted max-sm:order-last max-sm:p-0 max-sm:text-caption" data-numeric>
							{{ formatTime(entry.createdAt) }}
						</td>
						<td class="min-w-0 py-2.5 pl-3 max-sm:p-0">
							<p class="truncate text-body-s font-medium text-fg">{{ entry.actorName }}</p>
							<p class="truncate text-caption text-fg-subtle">{{ entry.actorEmail }}</p>
						</td>
						<td class="py-2.5 pl-3 max-sm:p-0">
							<UiTag>{{ entry.action }}</UiTag>
						</td>
						<td class="min-w-0 py-2.5 pl-3 max-md:hidden">
							<p class="text-caption text-fg-subtle">{{ entry.targetType }}</p>
							<p v-if="entry.targetLabel" class="truncate text-body-s text-fg">{{ entry.targetLabel }}</p>
						</td>
						<td class="py-2.5 pr-4 pl-3 font-mono text-caption break-all text-fg-subtle max-lg:hidden">
							{{ formatDetails(entry.details) || '—' }}
						</td>
					</tr>
				</tbody>
			</table>
			<UiEmptyState v-else :icon="ScrollText" title="No admin actions recorded yet" />

			<div v-if="hasMore" class="flex flex-col items-center gap-2 border-t border-border p-3">
				<UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
				<UiButton :loading="loadingMore" data-testid="admin-audit-load-more" @click="loadMore">Load more</UiButton>
			</div>
		</UiCard>
	</div>
</template>
