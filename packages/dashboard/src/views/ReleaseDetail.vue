<script setup lang="ts">
import { CircleCheck } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import { UiAlert, UiBadge, UiCard, UiEmptyState, UiSkeleton } from '../components/ui';
import { formatNumber, timeAgo } from '../lib/format';

interface Release {
	version: string;
	firstSeen: string;
	lastSeen: string;
	eventCount: number;
	issueCount: number;
	newIssueCount: number;
}

interface ReleaseIssue {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	platform: string;
	firstSeen: string;
	lastSeen: string;
	count: number;
	userCount: number;
	status: string;
	metadata: {
		type: string;
		value: string;
	};
	firstSeenInRelease: string;
	releaseEventCount: number;
}

const route = useRoute();
const slug = computed(() => route.params.slug as string);
const version = computed(() => decodeURIComponent(route.params.version as string));

const release = ref<Release | null>(null);
const issues = ref<ReleaseIssue[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function loadRelease() {
	loading.value = true;
	error.value = null;

	try {
		const response = await api.get<{
			release: Release;
			issues: ReleaseIssue[];
		}>(`/api/projects/${slug.value}/releases/${encodeURIComponent(version.value)}`);

		release.value = response.release;
		issues.value = response.issues;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load release';
	} finally {
		loading.value = false;
	}
}

function formatTime(dateString: string): string {
	return new Date(dateString).toLocaleString();
}

onMounted(() => loadRelease());
watch(version, () => loadRelease());
</script>

<template>
	<div class="flex flex-col gap-5">
		<!-- Loading -->
		<div v-if="loading" class="flex flex-col gap-5" data-testid="release-loading">
			<UiSkeleton variant="line" :count="2" label="Loading release" class="max-w-md" />
			<UiSkeleton variant="block" label="Loading numbers" class="h-[70px]" />
			<UiCard><UiSkeleton :count="4" label="Loading issues" /></UiCard>
		</div>

		<!-- Error -->
		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadRelease">{{ error }}</UiAlert>

		<!-- Release detail -->
		<template v-else-if="release">
			<header class="flex flex-col gap-2">
				<div class="flex flex-wrap items-center gap-2.5">
					<h1 class="font-mono text-heading-l break-all text-fg">{{ release.version }}</h1>
					<span
						v-if="release.newIssueCount > 0"
						class="inline-flex h-[22px] items-center rounded-full bg-level-warning-bg px-2 text-caption font-medium text-level-warning"
					>
						{{ release.newIssueCount }} new issues
					</span>
				</div>
				<p class="text-body-s text-fg-muted">
					First seen {{ formatTime(release.firstSeen) }} · last seen {{ timeAgo(release.lastSeen) }}
				</p>
			</header>

			<dl class="grid grid-cols-2 overflow-hidden rounded-[10px] border border-border bg-surface sm:grid-cols-4" data-numeric>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-b sm:border-r">
					<dt class="text-caption text-fg-subtle">Events</dt>
					<dd class="text-heading-m text-fg">{{ formatNumber(release.eventCount) }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-b max-sm:border-l sm:border-r">
					<dt class="text-caption text-fg-subtle">Issues</dt>
					<dd class="text-heading-m text-fg">{{ formatNumber(release.issueCount) }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 sm:border-r">
					<dt class="text-caption text-fg-subtle">New issues</dt>
					<dd class="text-heading-m text-fg">{{ formatNumber(release.newIssueCount) }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-l">
					<dt class="text-caption text-fg-subtle">Last seen</dt>
					<dd class="text-heading-m text-fg" :title="formatTime(release.lastSeen)">{{ timeAgo(release.lastSeen) }}</dd>
				</div>
			</dl>

			<UiCard title="Issues in this release" :meta="issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : undefined">
				<UiEmptyState v-if="issues.length === 0" :icon="CircleCheck" title="No issues found in this release." />
				<table v-else class="w-full border-collapse text-left max-sm:block sm:table-fixed">
					<caption class="sr-only">Issues in {{ release.version }}</caption>
					<thead class="max-sm:sr-only">
						<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
							<th scope="col" class="py-2 pl-4 font-semibold">Issue</th>
							<th scope="col" class="w-36 py-2 pr-4 text-right font-semibold">First in release</th>
							<th scope="col" class="w-28 py-2 pr-4 text-right font-semibold">In release</th>
							<th scope="col" class="w-24 py-2 pr-4 text-right font-semibold">Total</th>
						</tr>
					</thead>
					<tbody class="max-sm:block">
						<tr
							v-for="issue in issues"
							:key="issue.id"
							class="relative border-b border-border align-top transition-colors last:border-b-0 hover:bg-raised max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-4 max-sm:py-3"
							data-testid="release-issue-row"
						>
							<td class="min-w-0 py-3 pl-4 max-sm:basis-full max-sm:p-0">
								<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
									<UiBadge :level="issue.level" />
									<RouterLink
										:to="`/projects/${slug}/issues/${issue.id}`"
										class="text-body font-medium text-fg outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-accent/40"
									>
										{{ issue.metadata.type }}
									</RouterLink>
									<span
										v-if="issue.firstSeen === issue.firstSeenInRelease"
										class="inline-flex h-5 items-center rounded-full bg-level-warning-bg px-2 text-caption font-medium text-level-warning"
									>
										new
									</span>
									<span class="min-w-0 truncate text-body text-fg-muted max-sm:basis-full">{{ issue.metadata.value || issue.title }}</span>
								</span>
								<span v-if="issue.culprit" class="mt-1 block truncate font-mono text-caption text-fg-subtle">{{ issue.culprit }}</span>
							</td>
							<td class="py-3 pr-4 text-right text-body-s text-fg-subtle max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric>
								<span class="sm:hidden">First in release </span>{{ timeAgo(issue.firstSeenInRelease) }}
							</td>
							<td class="py-3 pr-4 text-right text-body-s font-medium text-fg max-sm:inline max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric :title="'Events in this release'">
								{{ formatNumber(issue.releaseEventCount) }}<span class="font-normal text-fg-subtle sm:hidden"> in release</span>
							</td>
							<td class="py-3 pr-4 text-right text-body-s text-fg-subtle max-sm:inline max-sm:p-0 max-sm:text-left max-sm:text-caption" data-numeric :title="'Total events'">
								{{ formatNumber(issue.count) }}<span class="sm:hidden"> total</span>
							</td>
						</tr>
					</tbody>
				</table>
			</UiCard>
		</template>
	</div>
</template>
