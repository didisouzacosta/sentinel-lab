<script setup lang="ts">
import { ArrowUpRight, CircleCheck } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import AppIssueRow, { type IssueRowData } from '../components/app/AppIssueRow.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import AppStat from '../components/app/AppStat.vue';
import AppTrendChart from '../components/app/AppTrendChart.vue';
import { UiAlert, UiButton, UiCard, UiEmptyState, UiSkeleton } from '../components/ui';
import { formatNumber } from '../lib/format';
import { fillHourly } from '../lib/trend';
import { useProjectsStore } from '../stores/projects';

interface SummaryData {
	issuesByStatus: Record<string, number>;
	events24h: number;
	events7d: number;
	trend: Array<{ bucket: string; count: number }>;
	topIssues: IssueRowData[];
	totalUsers: number;
}

const route = useRoute();
const projectsStore = useProjectsStore();
const slug = computed(() => route.params.slug as string);
const project = computed(() => projectsStore.projects.find((p) => p.slug === slug.value));

const summary = ref<SummaryData | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const unresolvedCount = computed(() => summary.value?.issuesByStatus?.unresolved || 0);
// Full 7-day hourly window (the API omits empty hours)
const trendWindow = computed(() =>
	summary.value?.trend.length ? fillHourly(summary.value.trend) : [],
);
const peak = computed(() =>
	summary.value?.trend.length ? Math.max(...summary.value.trend.map((t) => t.count)) : 0,
);

async function loadSummary() {
	loading.value = true;
	error.value = null;
	try {
		summary.value = await api.get<SummaryData>(`/api/projects/${slug.value}/summary`);
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load summary';
	} finally {
		loading.value = false;
	}
}

onMounted(() => loadSummary());
watch(slug, () => loadSummary());
</script>

<template>
	<div class="flex flex-col gap-6">
		<AppPageHeader
			title="Overview"
			:subtitle="project ? `${project.name} · ${project.platform}` : undefined"
		>
			<template #actions>
				<UiButton :to="`/projects/${slug}/issues`" :icon="ArrowUpRight">View issues</UiButton>
			</template>
		</AppPageHeader>

		<!-- Loading -->
		<div v-if="loading" class="flex flex-col gap-6" data-testid="overview-loading">
			<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<UiSkeleton v-for="i in 4" :key="i" variant="block" label="Loading metrics" class="h-[106px]" />
			</div>
			<UiSkeleton variant="block" label="Loading trend" class="h-64" />
			<UiCard><UiSkeleton :count="3" label="Loading issues" /></UiCard>
		</div>

		<!-- Error -->
		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadSummary">
			{{ error }}
		</UiAlert>

		<template v-else-if="summary">
			<!-- Metric cards (click through to the issues list) -->
			<section aria-label="Key metrics" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<AppStat
					label="Unresolved issues"
					:value="formatNumber(unresolvedCount)"
					hint="Opens the unresolved list"
					:to="`/projects/${slug}/issues?status=unresolved`"
				/>
				<AppStat
					label="Events (24h)"
					:value="formatNumber(summary.events24h)"
					hint="All statuses"
					:to="`/projects/${slug}/issues?status=`"
				/>
				<AppStat
					label="Events (7d)"
					:value="formatNumber(summary.events7d)"
					hint="All statuses"
					:to="`/projects/${slug}/issues?status=`"
				/>
				<AppStat
					label="Users affected"
					:value="formatNumber(summary.totalUsers)"
					hint="Sorted by users"
					:to="`/projects/${slug}/issues?sort=user`"
				/>
			</section>

			<!-- Error trend -->
			<UiCard
				title="Error trend"
				:meta="summary.trend.length ? `Last 7 days · peak ${formatNumber(peak)} events` : 'Last 7 days'"
			>
				<div class="px-5 pt-5 pb-4">
					<p v-if="summary.trend.length === 0" class="flex h-44 items-center justify-center text-body-s text-fg-subtle">
						No events recorded yet
					</p>
					<AppTrendChart v-else :points="trendWindow" label="Error trend, last 7 days" />
				</div>
			</UiCard>

			<!-- Top active issues -->
			<UiCard title="Top unresolved issues">
				<template #actions>
					<RouterLink :to="`/projects/${slug}/issues`" class="text-body-s font-medium text-accent-text hover:underline">
						View all
					</RouterLink>
				</template>
				<UiEmptyState
					v-if="summary.topIssues.length === 0"
					:icon="CircleCheck"
					title="No unresolved issues"
					description="New errors from your SDKs show up here."
				/>
				<ul v-else class="divide-y divide-border">
					<li v-for="issue in summary.topIssues" :key="issue.id">
						<AppIssueRow :issue="issue" :to="`/projects/${slug}/issues/${issue.id}`" />
					</li>
				</ul>
			</UiCard>
		</template>
	</div>
</template>
