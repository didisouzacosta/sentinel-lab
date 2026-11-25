<script setup lang="ts">
import { Package } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import { UiAlert, UiButton, UiCard, UiEmptyState, UiSkeleton } from '../components/ui';
import { formatNumber, timeAgo } from '../lib/format';

interface Release {
	version: string;
	firstSeen: string;
	lastSeen: string;
	eventCount: number;
	issueCount: number;
	newIssueCount: number;
}

const route = useRoute();
const slug = computed(() => route.params.slug as string);

const releases = ref<Release[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const hasMore = ref(false);
const nextCursor = ref<string | undefined>();

async function loadReleases(append = false) {
	if (append) loadingMore.value = true;
	else loading.value = true;
	error.value = null;

	try {
		const params = new URLSearchParams();
		if (append && nextCursor.value) {
			params.set('cursor', nextCursor.value);
		}

		const response = await api.get<{
			releases: Release[];
			hasMore: boolean;
			nextCursor?: string;
		}>(`/api/projects/${slug.value}/releases?${params}`);

		if (append) {
			releases.value = [...releases.value, ...response.releases];
		} else {
			releases.value = response.releases;
		}
		hasMore.value = response.hasMore;
		nextCursor.value = response.nextCursor;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load releases';
	} finally {
		loading.value = false;
		loadingMore.value = false;
	}
}

const releaseLink = (version: string) =>
	`/projects/${slug.value}/releases/${encodeURIComponent(version)}`;

onMounted(() => loadReleases());
watch(slug, () => loadReleases());
</script>

<template>
	<div class="flex flex-col gap-5">
		<AppPageHeader title="Releases" subtitle="Versions reported by your SDKs (the release option)" />

		<!-- Loading -->
		<UiCard v-if="loading && releases.length === 0">
			<UiSkeleton :count="5" label="Loading releases" />
		</UiCard>

		<!-- Error -->
		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadReleases()">{{ error }}</UiAlert>

		<!-- Empty state -->
		<UiCard v-else-if="releases.length === 0">
			<UiEmptyState
				:icon="Package"
				title="No releases yet"
				description="Releases appear here once you set the release option in your Sentry SDK."
			>
				<UiButton :to="`/setup?project=${slug}`" size="sm">Open SDK setup</UiButton>
			</UiEmptyState>
		</UiCard>

		<!-- Releases -->
		<UiCard v-else>
			<table class="w-full border-collapse text-left max-sm:block sm:table-fixed">
				<caption class="sr-only">Releases</caption>
				<thead class="max-sm:sr-only">
					<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
						<th scope="col" class="py-2 pl-4 font-semibold">Version</th>
						<th scope="col" class="w-32 py-2 pr-4 text-right font-semibold">First seen</th>
						<th scope="col" class="w-32 py-2 pr-4 text-right font-semibold">Last seen</th>
						<th scope="col" class="w-24 py-2 pr-4 text-right font-semibold">Events</th>
						<th scope="col" class="w-20 py-2 pr-4 text-right font-semibold">Issues</th>
					</tr>
				</thead>
				<tbody class="max-sm:block">
					<tr
						v-for="release in releases"
						:key="release.version"
						class="relative border-b border-border transition-colors last:border-b-0 hover:bg-raised max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-4 max-sm:py-3"
						data-testid="release-row"
					>
						<td class="min-w-0 py-3 pl-4 max-sm:basis-full max-sm:p-0">
							<span class="flex min-w-0 items-center gap-2.5">
								<!-- Stretched link: the whole row opens the release -->
								<RouterLink
									:to="releaseLink(release.version)"
									class="min-w-0 truncate font-mono text-body text-fg outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-accent/40"
								>
									{{ release.version }}
								</RouterLink>
								<span
									v-if="release.newIssueCount > 0"
									class="inline-flex h-5 shrink-0 items-center rounded-full bg-level-warning-bg px-2 text-caption font-medium text-level-warning"
								>
									{{ release.newIssueCount }} new
								</span>
							</span>
						</td>
						<td class="py-3 pr-4 text-right text-body-s text-fg-subtle max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric>
							<span class="sm:hidden">First seen </span>{{ timeAgo(release.firstSeen) }}
						</td>
						<td class="py-3 pr-4 text-right text-body-s text-fg-subtle max-sm:hidden" data-numeric>{{ timeAgo(release.lastSeen) }}</td>
						<td class="py-3 pr-4 text-right text-body-s font-medium text-fg max-sm:inline max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric>
							{{ formatNumber(release.eventCount) }}<span class="font-normal text-fg-subtle sm:hidden"> events</span>
						</td>
						<td class="py-3 pr-4 text-right text-body-s font-medium text-fg max-sm:inline max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric>
							{{ formatNumber(release.issueCount) }}<span class="font-normal text-fg-subtle sm:hidden"> issues</span>
						</td>
					</tr>
				</tbody>
			</table>
		</UiCard>

		<!-- Load more -->
		<div v-if="hasMore && releases.length > 0" class="flex items-center justify-between gap-3">
			<span class="text-caption text-fg-subtle">Showing {{ releases.length }}</span>
			<UiButton size="sm" :loading="loadingMore" @click="loadReleases(true)">
				{{ loadingMore ? 'Loading...' : 'Load More' }}
			</UiButton>
		</div>
	</div>
</template>
