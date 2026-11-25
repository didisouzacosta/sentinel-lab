<script setup lang="ts">
export interface DescriptionItem {
	label: string;
	value: string | number | null | undefined;
	/** Monospace value (ids, versions, IPs). */
	mono?: boolean;
}

withDefaults(defineProps<{ items: DescriptionItem[]; layout?: 'rows' | 'grid' }>(), {
	layout: 'rows',
});
</script>

<template>
	<dl
		:class="
			layout === 'grid'
				? 'grid grid-cols-1 gap-x-6 gap-y-3.5 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3'
				: 'flex flex-col gap-2.5 px-4 py-3.5'
		"
	>
		<div
			v-for="item in items"
			:key="item.label"
			:class="layout === 'grid' ? 'flex flex-col gap-1' : 'flex gap-3'"
		>
			<dt
				:class="[
					'text-fg-subtle',
					layout === 'grid' ? 'text-caption' : 'w-24 shrink-0 text-body-s',
				]"
			>
				{{ item.label }}
			</dt>
			<dd
				:class="[
					'min-w-0 truncate text-fg',
					item.mono ? 'font-mono text-caption leading-[18px]' : 'text-body-s',
				]"
				:title="item.value != null ? String(item.value) : undefined"
			>
				<slot :name="item.label" :item="item">{{ item.value ?? '—' }}</slot>
			</dd>
		</div>
	</dl>
</template>
