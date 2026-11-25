<script setup lang="ts">
import {
	Check,
	CircleCheck,
	Eye,
	EyeOff,
	GitMerge,
	History,
	Plug,
	SlidersHorizontal,
	Trash2,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import AppIssueFilters, { type TagFacet } from '../components/app/AppIssueFilters.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import {
	UiAlert,
	UiBadge,
	UiButton,
	UiCard,
	UiCheckbox,
	UiDialog,
	UiEmptyState,
	UiSkeleton,
	UiTabs,
	UiTag,
} from '../components/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { formatNumber, timeAgo } from '../lib/format';
import { useProjectsStore } from '../stores/projects';

interface Issue {
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
	snoozedUntil: string | null;
	metadata: {
		type: string;
		value: string;
	};
}

const route = useRoute();
const toast = useToast();
const askConfirm = useConfirm();
const slug = computed(() => route.params.slug as string);
const projectsStore = useProjectsStore();
// Deleting issues is for project owners and admins (the server enforces it).
const canDelete = computed(() => projectsStore.canManage(slug.value));

/** Status values the route query may seed (empty = all). */
const QUERY_STATUSES = new Set(['', 'unresolved', 'resolved', 'ignored', 'snoozed']);
const PAGE_SIZES = [25, 50, 100];

function statusFromQuery(): string {
	const raw = route.query.status;
	return typeof raw === 'string' && QUERY_STATUSES.has(raw) ? raw : 'unresolved';
}
function sortFromQuery(): string {
	return route.query.sort === 'user' ? 'user' : '';
}
function limitFromQuery(): number {
	const raw = Number(route.query.limit);
	return PAGE_SIZES.includes(raw) ? raw : 25;
}

const statusTabs = [
	{ value: 'unresolved', label: 'Unresolved' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'ignored', label: 'Ignored' },
	{ value: 'snoozed', label: 'Snoozed' },
	{ value: '', label: 'All' },
];

const issues = ref<Issue[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
// Seeded from the route query so overview cards can deep-link with filters
const statusFilter = ref<string>(statusFromQuery());
const sortMode = ref<string>(sortFromQuery());
const pageSize = ref<number>(limitFromQuery());
const environmentFilter = ref<string>('');
const environments = ref<Array<{ name: string; issueCount: number }>>([]);
const hasMore = ref(false);
const nextCursor = ref<string | undefined>();
const tagFacets = ref<TagFacet[]>([]);
const selectedTags = ref<string[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const bulkLoading = ref(false);
const merging = ref(false);
const filtersOpen = ref(false);

const allSelected = computed(
	() => issues.value.length > 0 && issues.value.every((i) => selectedIds.value.has(i.id)),
);
const someSelected = computed(() => selectedIds.value.size > 0);
const selectionLabel = computed(
	() => `${selectedIds.value.size} issue${selectedIds.value.size === 1 ? '' : 's'}`,
);
const activeFilterCount = computed(
	() => selectedTags.value.length + (environmentFilter.value ? 1 : 0),
);
const filtered = computed(() => activeFilterCount.value > 0 || statusFilter.value !== 'unresolved');

function toggleSelect(id: string) {
	const next = new Set(selectedIds.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	selectedIds.value = next;
}

function toggleSelectAll() {
	selectedIds.value = allSelected.value ? new Set() : new Set(issues.value.map((i) => i.id));
}

function clearSelection() {
	selectedIds.value = new Set();
}

const STATUS_DONE: Record<string, string> = {
	resolved: 'resolved',
	ignored: 'ignored',
	unresolved: 'reopened',
};

async function bulkUpdateStatus(newStatus: string) {
	if (selectedIds.value.size === 0) return;
	const label = selectionLabel.value;
	bulkLoading.value = true;
	try {
		await api.patch(`/api/projects/${slug.value}/issues/bulk`, {
			issueIds: Array.from(selectedIds.value),
			status: newStatus,
		});
		for (const issue of issues.value) {
			if (selectedIds.value.has(issue.id)) issue.status = newStatus;
		}
		if (statusFilter.value && statusFilter.value !== newStatus) {
			issues.value = issues.value.filter((i) => !selectedIds.value.has(i.id));
		}
		clearSelection();
		toast.success(`${label} ${STATUS_DONE[newStatus] ?? 'updated'}`);
	} catch (err) {
		toast.error(
			`Could not update the issues: ${err instanceof Error ? err.message : 'unknown error'}`,
		);
	} finally {
		bulkLoading.value = false;
	}
}

function selectedTitles(): string[] {
	return issues.value
		.filter((i) => selectedIds.value.has(i.id))
		.slice(0, 5)
		.map((i) => `${i.metadata?.type || i.title}: ${i.metadata?.value || ''}`.trim());
}

async function bulkDelete() {
	if (selectedIds.value.size === 0) return;
	const label = selectionLabel.value;
	const ok = await askConfirm({
		title: `Delete ${label}?`,
		description: 'All their events and attachments are removed. This cannot be undone.',
		confirmLabel: `Delete ${label}`,
		tone: 'danger',
		items: selectedTitles(),
	});
	if (!ok) return;
	bulkLoading.value = true;
	try {
		await api.patch(`/api/projects/${slug.value}/issues/bulk`, {
			issueIds: Array.from(selectedIds.value),
			action: 'delete',
		});
		issues.value = issues.value.filter((i) => !selectedIds.value.has(i.id));
		clearSelection();
		toast.success(`${label} deleted`);
	} catch (err) {
		toast.error(
			`Could not delete the issues: ${err instanceof Error ? err.message : 'unknown error'}`,
		);
	} finally {
		bulkLoading.value = false;
	}
}

async function mergeSelected() {
	if (selectedIds.value.size < 2) return;
	// The first selected issue in list order becomes the primary
	const primaryIssue = issues.value.find((i) => selectedIds.value.has(i.id));
	if (!primaryIssue) return;
	const count = selectedIds.value.size;
	const ok = await askConfirm({
		title: `Merge ${count} issues?`,
		description: `Events from ${count - 1} issue${count - 1 === 1 ? '' : 's'} move into "${primaryIssue.metadata?.type || primaryIssue.title}" (the first selected). This cannot be undone.`,
		confirmLabel: `Merge ${count} issues`,
		items: selectedTitles(),
	});
	if (!ok) return;

	merging.value = true;
	try {
		await api.post(`/api/projects/${slug.value}/issues/merge`, {
			primaryIssueId: primaryIssue.id,
			issueIds: Array.from(selectedIds.value),
		});
		clearSelection();
		await loadIssues();
		toast.success(`${count} issues merged`);
	} catch {
		toast.error('Failed to merge issues. Please try again.');
	} finally {
		merging.value = false;
	}
}

async function loadIssues(append = false) {
	if (append) {
		loadingMore.value = true;
	} else {
		loading.value = true;
		clearSelection();
	}
	error.value = null;

	try {
		const params = new URLSearchParams();
		if (statusFilter.value) params.set('status', statusFilter.value);
		if (environmentFilter.value) params.set('environment', environmentFilter.value);
		if (sortMode.value === 'user') params.set('sort', 'user_count');
		params.set('limit', String(pageSize.value));
		if (append && nextCursor.value) params.set('cursor', nextCursor.value);
		for (const tag of selectedTags.value) params.append('tag', tag);

		const response = await api.get<{
			issues: Issue[];
			hasMore: boolean;
			nextCursor?: string;
		}>(`/api/projects/${slug.value}/issues?${params}`);

		issues.value = append ? [...issues.value, ...response.issues] : response.issues;
		hasMore.value = response.hasMore;
		nextCursor.value = response.nextCursor;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load issues';
	} finally {
		loading.value = false;
		loadingMore.value = false;
	}
}

async function loadTagFacets() {
	try {
		const response = await api.get<{ facets: TagFacet[] }>(
			`/api/projects/${slug.value}/tags?limit=10`,
		);
		tagFacets.value = response.facets;
	} catch {
		// Ignore - tag filters just won't appear
	}
}

function getSelectedTagValue(key: string): string {
	const tag = selectedTags.value.find((t) => t.startsWith(`${key}:`));
	return tag ? tag.slice(key.length + 1) : '';
}

function toggleTag(key: string, value: string) {
	const rest = selectedTags.value.filter((t) => !t.startsWith(`${key}:`));
	selectedTags.value = value ? [...rest, `${key}:${value}`] : rest;
	loadIssues();
}

function removeTag(tag: string) {
	selectedTags.value = selectedTags.value.filter((t) => t !== tag);
	loadIssues();
}

function clearFilters() {
	const hadTags = selectedTags.value.length > 0;
	selectedTags.value = [];
	if (environmentFilter.value)
		environmentFilter.value = ''; // its watcher reloads
	else if (hadTags) loadIssues();
}

async function loadEnvironments() {
	try {
		const response = await api.get<{
			environments: Array<{ name: string; issueCount: number; lastSeen: string }>;
		}>(`/api/projects/${slug.value}/environments`);
		environments.value = response.environments;
	} catch {
		// Ignore - environment selector will just be empty
	}
}

async function updateStatus(issue: Issue, newStatus: string) {
	try {
		await api.patch(`/api/projects/${slug.value}/issues/${issue.id}`, { status: newStatus });
		issue.status = newStatus;
		toast.success(`Issue ${STATUS_DONE[newStatus] ?? 'updated'}`);
	} catch (err) {
		toast.error(
			`Could not update the issue: ${err instanceof Error ? err.message : 'unknown error'}`,
		);
	}
}

function isSnoozed(issue: Issue) {
	return !!issue.snoozedUntil && new Date(issue.snoozedUntil) > new Date();
}

// Esc clears the selection (when no dialog or menu is handling it)
function onKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || !someSelected.value || event.defaultPrevented) return;
	if (document.querySelector('dialog[open], [role="menu"]')) return; // the overlay handles Esc
	clearSelection();
}

onMounted(() => {
	loadIssues();
	loadTagFacets();
	loadEnvironments();
	window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(statusFilter, () => loadIssues());
watch(environmentFilter, () => loadIssues());
watch(pageSize, () => loadIssues());
watch(sortMode, () => loadIssues());
watch(slug, () => loadIssues());
// Component reuse: overview → issues navigations with a different query
// remount nothing, so re-seed the filters when the query changes.
watch(
	() => [route.query.status, route.query.sort, route.query.limit] as const,
	() => {
		const nextStatus = statusFromQuery();
		const nextSort = sortFromQuery();
		const nextLimit = limitFromQuery();
		// Ref watchers trigger the reload when values actually change
		if (nextStatus !== statusFilter.value) statusFilter.value = nextStatus;
		if (nextSort !== sortMode.value) sortMode.value = nextSort;
		if (nextLimit !== pageSize.value) pageSize.value = nextLimit;
	},
);
</script>

<template>
	<div class="flex flex-col gap-5" :class="someSelected ? 'pb-24 sm:pb-0' : ''">
		<AppPageHeader title="Issues" subtitle="Errors grouped by fingerprint, most recent first" />

		<UiTabs v-model="statusFilter" label="Issue status" :items="statusTabs" />

		<!-- Filters: toolbar on desktop, sheet on phones -->
		<div class="hidden md:block">
			<AppIssueFilters
				v-model:environment="environmentFilter"
				v-model:sort="sortMode"
				v-model:page-size="pageSize"
				:environments="environments"
				:facets="tagFacets"
				:tag-value="getSelectedTagValue"
				layout="inline"
				id-prefix="filters-inline"
				@tag="toggleTag"
			/>
		</div>
		<div class="md:hidden">
			<UiButton size="sm" :icon="SlidersHorizontal" data-testid="open-filters" @click="filtersOpen = true">
				Filters{{ activeFilterCount ? ` (${activeFilterCount})` : '' }}
			</UiButton>
		</div>
		<UiDialog v-model:open="filtersOpen" title="Filters">
			<AppIssueFilters
				v-model:environment="environmentFilter"
				v-model:sort="sortMode"
				v-model:page-size="pageSize"
				:environments="environments"
				:facets="tagFacets"
				:tag-value="getSelectedTagValue"
				layout="stacked"
				id-prefix="filters-sheet"
				@tag="toggleTag"
			/>
			<template #footer="{ close }">
				<UiButton v-if="activeFilterCount" variant="ghost" @click="clearFilters">Reset</UiButton>
				<UiButton variant="primary" @click="close">Show issues</UiButton>
			</template>
		</UiDialog>

		<!-- Active filters -->
		<div v-if="activeFilterCount > 0" class="flex flex-wrap items-center gap-2" data-testid="active-filters">
			<UiTag
				v-if="environmentFilter"
				tone="accent"
				removable
				:remove-label="`Remove environment ${environmentFilter}`"
				@remove="environmentFilter = ''"
			>
				environment: {{ environmentFilter }}
			</UiTag>
			<UiTag
				v-for="tag in selectedTags"
				:key="tag"
				tone="accent"
				removable
				:remove-label="`Remove filter ${tag}`"
				@remove="removeTag(tag)"
			>
				{{ tag.replace(':', ': ') }}
			</UiTag>
			<button type="button" class="text-caption text-fg-subtle hover:text-fg hover:underline" @click="clearFilters">
				Clear filters
			</button>
		</div>

		<!-- Loading -->
		<UiCard v-if="loading && issues.length === 0">
			<UiSkeleton :count="6" label="Loading issues" />
		</UiCard>

		<!-- Error -->
		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadIssues()">
			{{ error }}
		</UiAlert>

		<!-- Empty -->
		<UiCard v-else-if="issues.length === 0">
			<UiEmptyState
				v-if="filtered"
				:icon="CircleCheck"
				title="No issues match"
				description="Nothing in this status with the current filters."
			>
				<UiButton v-if="activeFilterCount" @click="clearFilters">Clear filters</UiButton>
			</UiEmptyState>
			<UiEmptyState v-else :icon="Plug" title="No issues yet" description="Configure your SDK to start capturing errors.">
				<UiButton variant="primary" :icon="Plug" :to="`/setup?project=${slug}`" data-testid="empty-setup-link">
					Set up an SDK
				</UiButton>
			</UiEmptyState>
		</UiCard>

		<!-- Issues -->
		<UiCard v-else class="overflow-visible">
			<!-- Bulk actions: sticky under the top bar; fixed at the bottom on phones -->
			<div
				v-if="someSelected"
				class="z-20 flex flex-wrap items-center gap-2 border-b border-border bg-accent-subtle px-4 py-2 max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:border-t max-sm:pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:sticky sm:top-14 sm:rounded-t-[10px]"
				data-testid="bulk-bar"
			>
				<UiCheckbox
					:model-value="allSelected"
					:indeterminate="someSelected && !allSelected"
					aria-label="Select all issues on this page"
					@update:model-value="toggleSelectAll"
				/>
				<span class="text-body-s font-medium text-accent-text" aria-live="polite">{{ selectionLabel }} selected</span>
				<span class="flex-1" />
				<UiButton size="sm" :icon="Check" :disabled="bulkLoading" @click="bulkUpdateStatus('resolved')">Resolve</UiButton>
				<UiButton size="sm" :icon="EyeOff" :disabled="bulkLoading" @click="bulkUpdateStatus('ignored')">Ignore</UiButton>
				<UiButton size="sm" :icon="History" :disabled="bulkLoading" @click="bulkUpdateStatus('unresolved')">Reopen</UiButton>
				<UiButton
					v-if="selectedIds.size >= 2"
					size="sm"
					:icon="GitMerge"
					:loading="merging"
					:disabled="bulkLoading"
					@click="mergeSelected"
				>
					{{ merging ? 'Merging...' : 'Merge' }}
				</UiButton>
				<UiButton
					v-if="canDelete"
					size="sm"
					variant="danger"
					:icon="Trash2"
					:disabled="bulkLoading"
					data-testid="bulk-delete"
					@click="bulkDelete"
				>
					Delete
				</UiButton>
				<UiButton size="sm" variant="ghost" @click="clearSelection">Clear</UiButton>
			</div>

			<table class="w-full border-collapse text-left max-sm:block sm:table-fixed">
				<caption class="sr-only">Issues</caption>
				<thead class="max-sm:sr-only">
					<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
						<th scope="col" class="w-10 py-2 pl-4">
							<UiCheckbox
								v-if="!someSelected"
								:model-value="allSelected"
								aria-label="Select all issues on this page"
								@update:model-value="toggleSelectAll"
							/>
						</th>
						<th scope="col" class="py-2 font-semibold">Issue</th>
						<th scope="col" class="w-28 py-2 pr-4 text-right font-semibold">Last seen</th>
						<th scope="col" class="w-20 py-2 pr-4 text-right font-semibold">Events</th>
						<th scope="col" class="w-20 py-2 pr-4 text-right font-semibold">Users</th>
					</tr>
				</thead>
				<tbody class="max-sm:block">
					<tr
						v-for="issue in issues"
						:key="issue.id"
						class="group border-b border-border align-top transition-colors last:border-b-0 hover:bg-raised max-sm:flex max-sm:gap-3 max-sm:px-4 max-sm:py-3"
						:class="selectedIds.has(issue.id) ? 'bg-accent-subtle hover:bg-accent-subtle' : ''"
						data-testid="issue-row"
					>
						<td class="py-3.5 pl-4 max-sm:p-0 max-sm:pt-0.5">
							<UiCheckbox
								:model-value="selectedIds.has(issue.id)"
								:aria-label="`Select ${issue.metadata?.type || issue.title}`"
								@update:model-value="toggleSelect(issue.id)"
							/>
						</td>
						<td class="relative min-w-0 py-3 pr-4 max-sm:flex-1 max-sm:p-0">
							<RouterLink :to="`/projects/${slug}/issues/${issue.id}`" class="block rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-accent/40">
								<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
									<UiBadge :level="issue.level" />
									<span class="text-body font-medium text-fg">{{ issue.metadata?.type || issue.title }}</span>
									<span class="min-w-0 truncate text-body text-fg-muted max-sm:basis-full">{{ issue.metadata?.value || issue.title }}</span>
								</span>
								<span class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-fg-subtle">
									<span v-if="issue.culprit" class="min-w-0 truncate font-mono">{{ issue.culprit }}</span>
									<span v-if="issue.culprit" aria-hidden="true">·</span>
									<span>first seen {{ timeAgo(issue.firstSeen) }}</span>
								</span>
								<span v-if="isSnoozed(issue)" class="mt-1 block text-caption text-level-warning">
									Snoozed until {{ new Date(issue.snoozedUntil!).toLocaleString() }}
								</span>
								<!-- Phone-only numbers line (columns are hidden there) -->
								<span class="mt-1.5 flex gap-3 text-caption sm:hidden" data-numeric>
									<span class="text-fg">{{ formatNumber(issue.count) }} events</span>
									<span class="text-fg">{{ formatNumber(issue.userCount) }} users</span>
									<span class="text-fg-subtle">{{ timeAgo(issue.lastSeen) }}</span>
								</span>
							</RouterLink>
							<!-- Quick actions: on hover/focus (desktop), always on phones -->
							<div
								class="mt-1.5 flex items-center gap-1 sm:pointer-events-none sm:absolute sm:top-2 sm:right-2 sm:mt-0 sm:rounded-lg sm:border sm:border-border sm:bg-surface sm:p-0.5 sm:opacity-0 sm:shadow-xs sm:transition-opacity sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100">
								<UiButton v-if="issue.status !== 'resolved'" size="sm" variant="ghost" :icon="Check" class="max-sm:-ml-2.5" @click="updateStatus(issue, 'resolved')">
									Resolve
								</UiButton>
								<UiButton v-if="issue.status !== 'ignored'" size="sm" variant="ghost" :icon="EyeOff" @click="updateStatus(issue, 'ignored')">
									Ignore
								</UiButton>
								<UiButton v-if="issue.status !== 'unresolved'" size="sm" variant="ghost" :icon="Eye" @click="updateStatus(issue, 'unresolved')">
									Reopen
								</UiButton>
							</div>
						</td>
						<td class="py-3.5 pr-4 text-right text-body-s text-fg-subtle max-sm:hidden" data-numeric>{{ timeAgo(issue.lastSeen) }}</td>
						<td class="py-3.5 pr-4 text-right text-body-s font-medium text-fg max-sm:hidden" data-numeric>{{ formatNumber(issue.count) }}</td>
						<td class="py-3.5 pr-4 text-right text-body-s font-medium text-fg max-sm:hidden" data-numeric>{{ formatNumber(issue.userCount) }}</td>
					</tr>
				</tbody>
			</table>
		</UiCard>

		<!-- Load more -->
		<div v-if="hasMore && issues.length > 0" class="flex items-center justify-between gap-3">
			<span class="text-caption text-fg-subtle">Showing {{ issues.length }}</span>
			<UiButton size="sm" :loading="loadingMore" @click="loadIssues(true)">
				{{ loadingMore ? 'Loading...' : 'Load More' }}
			</UiButton>
		</div>
	</div>
</template>
