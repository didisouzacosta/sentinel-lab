<script setup lang="ts">
import UiFormField from '../ui/UiFormField.vue';
import UiSelect from '../ui/UiSelect.vue';

export interface TagFacet {
	key: string;
	issueCount: number;
	eventCount: number;
	topValues: Array<{ value: string; issueCount: number; eventCount: number }>;
}

defineProps<{
	environments: Array<{ name: string; issueCount: number }>;
	facets: TagFacet[];
	/** Current value per tag key ('' = any). */
	tagValue: (key: string) => string;
	/** inline = toolbar row (desktop); stacked = labelled fields (mobile sheet). */
	layout: 'inline' | 'stacked';
	idPrefix: string;
}>();

const environment = defineModel<string>('environment', { required: true });
const sort = defineModel<string>('sort', { required: true });
const pageSize = defineModel<number>('pageSize', { required: true });
const emit = defineEmits<{ tag: [key: string, value: string] }>();

function onTag(key: string, event: Event) {
	emit('tag', key, (event.target as HTMLSelectElement).value);
}
</script>

<template>
	<!-- Inline toolbar -->
	<div v-if="layout === 'inline'" class="flex flex-wrap items-center gap-2">
		<UiSelect v-if="environments.length > 0" v-model="environment" aria-label="Environment">
			<option value="">All environments</option>
			<option v-for="env in environments" :key="env.name" :value="env.name">
				{{ env.name }} ({{ env.issueCount }})
			</option>
		</UiSelect>
		<UiSelect
			v-for="facet in facets"
			:key="facet.key"
			:model-value="tagValue(facet.key)"
			:aria-label="`Tag ${facet.key}`"
			@change="onTag(facet.key, $event)"
		>
			<option value="">{{ facet.key }}: any</option>
			<option v-for="tv in facet.topValues" :key="tv.value" :value="tv.value">
				{{ facet.key }}: {{ tv.value }} ({{ tv.issueCount }})
			</option>
		</UiSelect>
		<span class="flex-1" />
		<UiSelect v-model="sort" aria-label="Sort issues">
			<option value="">Sort: last seen</option>
			<option value="user">Sort: most users</option>
		</UiSelect>
		<UiSelect v-model.number="pageSize" aria-label="Issues per page" title="Issues per page">
			<option :value="25">25 / page</option>
			<option :value="50">50 / page</option>
			<option :value="100">100 / page</option>
		</UiSelect>
	</div>

	<!-- Stacked fields (inside the mobile filter sheet) -->
	<div v-else class="flex flex-col gap-4">
		<UiFormField v-if="environments.length > 0" v-slot="f" label="Environment" :id="`${idPrefix}-env`">
			<UiSelect :id="f.id" v-model="environment" class="w-full">
				<option value="">All environments</option>
				<option v-for="env in environments" :key="env.name" :value="env.name">
					{{ env.name }} ({{ env.issueCount }})
				</option>
			</UiSelect>
		</UiFormField>
		<UiFormField v-for="facet in facets" :key="facet.key" v-slot="f" :label="facet.key" :id="`${idPrefix}-tag-${facet.key}`">
			<UiSelect :id="f.id" :model-value="tagValue(facet.key)" class="w-full" @change="onTag(facet.key, $event)">
				<option value="">Any</option>
				<option v-for="tv in facet.topValues" :key="tv.value" :value="tv.value">
					{{ tv.value }} ({{ tv.issueCount }})
				</option>
			</UiSelect>
		</UiFormField>
		<UiFormField v-slot="f" label="Sort by" :id="`${idPrefix}-sort`">
			<UiSelect :id="f.id" v-model="sort" class="w-full">
				<option value="">Last seen</option>
				<option value="user">Most users</option>
			</UiSelect>
		</UiFormField>
		<UiFormField v-slot="f" label="Issues per page" :id="`${idPrefix}-limit`">
			<UiSelect :id="f.id" v-model.number="pageSize" class="w-full">
				<option :value="25">25</option>
				<option :value="50">50</option>
				<option :value="100">100</option>
			</UiSelect>
		</UiFormField>
	</div>
</template>
