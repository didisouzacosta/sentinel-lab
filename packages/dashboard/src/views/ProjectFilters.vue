<script setup lang="ts">
import { Funnel, Plus, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiDialog,
	UiEmptyState,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiSwitch,
	UiTag,
} from '../components/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { formatNumber } from '../lib/format';

interface InboundFilter {
	id: string;
	filterType: string;
	pattern: string;
	enabled: boolean;
	description: string | null;
	droppedCount: number;
	createdAt: string;
}

const route = useRoute();
const slug = computed(() => route.params.slug as string);
const toast = useToast();
const askConfirm = useConfirm();

const filters = ref<InboundFilter[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const dialogOpen = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const blankFilter = () => ({ filterType: 'message', pattern: '', description: '' });
const newFilter = ref(blankFilter());

const FILTER_TYPES: Record<string, string> = {
	message: 'Error message',
	error_type: 'Exception type',
	ip_address: 'IP address',
	release: 'Release',
	environment: 'Environment',
};

const matchHelp = computed(() => {
	const t = newFilter.value.filterType;
	if (t === 'ip_address' || t === 'release') return 'Exact match';
	if (t === 'environment') return 'Case-insensitive exact match';
	return 'Case-insensitive substring match';
});

const totalDropped = computed(() => filters.value.reduce((sum, f) => sum + f.droppedCount, 0));

const suggestions = [
	{
		filterType: 'message',
		pattern: 'ResizeObserver loop',
		description: 'Browser ResizeObserver loop errors',
	},
	{
		filterType: 'message',
		pattern: 'Non-Error exception captured',
		description: 'Non-Error objects thrown as exceptions',
	},
	{
		filterType: 'error_type',
		pattern: 'ChunkLoadError',
		description: 'Webpack chunk loading failures',
	},
];

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

async function loadFilters() {
	loading.value = true;
	loadError.value = null;
	try {
		const response = await api.get<{ filters: InboundFilter[] }>(
			`/api/projects/${slug.value}/filters`,
		);
		filters.value = response.filters;
	} catch (err) {
		loadError.value = message(err, 'Failed to load filters');
	} finally {
		loading.value = false;
	}
}

function openCreate(prefill?: (typeof suggestions)[number]) {
	newFilter.value = prefill ? { ...prefill } : blankFilter();
	createError.value = null;
	dialogOpen.value = true;
}

async function createFilter() {
	if (!newFilter.value.pattern.trim()) return;
	creating.value = true;
	createError.value = null;
	try {
		await api.post(`/api/projects/${slug.value}/filters`, {
			filterType: newFilter.value.filterType,
			pattern: newFilter.value.pattern,
			description: newFilter.value.description || undefined,
		});
		dialogOpen.value = false;
		toast.success('Filter created');
		await loadFilters();
	} catch (err) {
		createError.value = message(err, 'Failed to create filter');
	} finally {
		creating.value = false;
	}
}

async function toggleFilter(filter: InboundFilter, enabled: boolean) {
	const previous = filter.enabled;
	filter.enabled = enabled; // optimistic; reverted below on failure
	try {
		await api.patch(`/api/projects/${slug.value}/filters/${filter.id}`, { enabled });
		toast.success(enabled ? 'Filter enabled' : 'Filter paused');
	} catch (err) {
		filter.enabled = previous;
		toast.error(message(err, 'Failed to update filter'));
	}
}

async function deleteFilter(filter: InboundFilter) {
	const ok = await askConfirm({
		title: 'Delete this filter?',
		description: 'Matching events will be stored again from now on.',
		items: [`${FILTER_TYPES[filter.filterType] ?? filter.filterType}: ${filter.pattern}`],
		confirmLabel: 'Delete filter',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/projects/${slug.value}/filters/${filter.id}`);
		filters.value = filters.value.filter((f) => f.id !== filter.id);
		toast.success('Filter deleted');
	} catch (err) {
		toast.error(message(err, 'Failed to delete filter'));
	}
}

function formatDate(dateString: string): string {
	return new Date(dateString).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

onMounted(() => loadFilters());
</script>

<template>
	<div class="mx-auto flex max-w-3xl flex-col gap-5">
		<AppPageHeader title="Inbound filters" subtitle="Drop noisy events before they are stored.">
			<template #actions>
				<UiButton variant="primary" :icon="Plus" data-testid="create-filter" @click="openCreate()">
					Create filter
				</UiButton>
			</template>
		</AppPageHeader>

		<UiSkeleton v-if="loading" :count="3" label="Loading filters" />

		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="loadFilters">
			{{ loadError }}
		</UiAlert>

		<template v-else-if="filters.length > 0">
			<dl class="grid grid-cols-2 overflow-hidden rounded-[10px] border border-border bg-surface" data-numeric>
				<div class="flex flex-col gap-1 border-r border-border px-4 py-3">
					<dt class="text-caption text-fg-subtle">Filters</dt>
					<dd class="text-heading-m text-fg">{{ filters.length }}</dd>
				</div>
				<div class="flex flex-col gap-1 px-4 py-3">
					<dt class="text-caption text-fg-subtle">Events dropped</dt>
					<dd class="text-heading-m text-fg">{{ formatNumber(totalDropped) }}</dd>
				</div>
			</dl>

			<UiCard as="ul" aria-label="Filters">
				<li
					v-for="filter in filters"
					:key="filter.id"
					class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
					data-testid="filter-row"
				>
					<div class="min-w-0 flex-1">
						<div class="flex min-w-0 flex-wrap items-center gap-2">
							<UiTag>{{ FILTER_TYPES[filter.filterType] ?? filter.filterType }}</UiTag>
							<code class="min-w-0 truncate font-mono text-body-s text-fg">{{ filter.pattern }}</code>
						</div>
						<p v-if="filter.description" class="mt-1 text-body-s text-fg-muted">{{ filter.description }}</p>
						<p class="mt-0.5 text-caption text-fg-subtle" data-numeric>
							<template v-if="!filter.enabled">Paused · </template>{{ formatNumber(filter.droppedCount) }} dropped · Created {{ formatDate(filter.createdAt) }}
						</p>
					</div>
					<UiSwitch
						:model-value="filter.enabled"
						:label="`${filter.enabled ? 'Pause' : 'Enable'} filter ${filter.pattern}`"
						@update:model-value="toggleFilter(filter, $event)"
					/>
					<UiButton
						variant="ghost"
						size="icon-sm"
						:icon="Trash2"
						:aria-label="`Delete filter ${filter.pattern}`"
						@click="deleteFilter(filter)"
					/>
				</li>
			</UiCard>
		</template>

		<UiCard v-else data-testid="filters-empty">
			<UiEmptyState
				title="No filters configured yet"
				description="Start from a common one or create your own."
				:icon="Funnel"
			/>
			<div class="flex flex-col gap-2 border-t border-border px-4 pt-3.5 pb-4">
				<h3 class="text-overline text-fg-subtle uppercase">Common filters</h3>
				<ul class="flex flex-col gap-2">
					<li
						v-for="s in suggestions"
						:key="s.pattern"
						class="flex items-center gap-3 rounded-lg border border-border bg-canvas px-3 py-2.5"
					>
						<div class="min-w-0 flex-1">
							<p class="text-body-s font-medium text-fg">{{ s.description }}</p>
							<code class="font-mono text-caption text-fg-subtle">{{ s.pattern }}</code>
						</div>
						<UiButton size="sm" :icon="Plus" :aria-label="`Add filter: ${s.description}`" @click="openCreate(s)">
							Add
						</UiButton>
					</li>
				</ul>
			</div>
		</UiCard>

		<UiDialog
			v-model:open="dialogOpen"
			title="New filter"
			description="Matching events are dropped before they are stored."
			form
			data-testid="filter-dialog"
			@submit="createFilter"
		>
			<div class="flex flex-col gap-4">
				<UiAlert v-if="createError" tone="error">{{ createError }}</UiAlert>
				<UiFormField v-slot="f" label="Filter type">
					<UiSelect :id="f.id" v-model="newFilter.filterType" class="w-full" data-testid="filter-type">
						<option v-for="(label, value) in FILTER_TYPES" :key="value" :value="value">{{ label }}</option>
					</UiSelect>
				</UiFormField>
				<UiFormField v-slot="f" label="Pattern" :help="matchHelp" required>
					<UiInput
						:id="f.id"
						v-model="newFilter.pattern"
						:aria-describedby="f.describedBy"
						required
						maxlength="500"
						placeholder="e.g. ResizeObserver loop"
						class="font-mono"
						data-testid="filter-pattern"
					/>
				</UiFormField>
				<UiFormField v-slot="f" label="Description (optional)">
					<UiInput :id="f.id" v-model="newFilter.description" placeholder="Why this filter exists" />
				</UiFormField>
			</div>
			<template #footer="{ close }">
				<UiButton @click="close">Cancel</UiButton>
				<UiButton
					type="submit"
					variant="primary"
					:loading="creating"
					:disabled="!newFilter.pattern.trim()"
					data-testid="filter-submit"
				>
					Create filter
				</UiButton>
			</template>
		</UiDialog>
	</div>
</template>
