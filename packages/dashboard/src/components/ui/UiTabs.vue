<script setup lang="ts" generic="T extends string | number">
import { nextTick, ref } from 'vue';

export interface TabItem<V> {
	value: V;
	label: string;
	count?: number | string;
	/** Optional data-testid for the tab button. */
	testId?: string;
}

const props = defineProps<{ items: TabItem<T>[]; label: string }>();
const model = defineModel<T>({ required: true });
const tabs = ref<HTMLButtonElement[]>([]);

async function select(index: number) {
	const item = props.items[index];
	if (!item) return;
	model.value = item.value;
	await nextTick();
	tabs.value[index]?.focus();
}

// WAI-ARIA tabs: arrows move and select, Home/End jump.
function onKeydown(event: KeyboardEvent, index: number) {
	const last = props.items.length - 1;
	const next =
		event.key === 'ArrowRight'
			? index === last
				? 0
				: index + 1
			: event.key === 'ArrowLeft'
				? index === 0
					? last
					: index - 1
				: event.key === 'Home'
					? 0
					: event.key === 'End'
						? last
						: -1;
	if (next < 0) return;
	event.preventDefault();
	void select(next);
}
</script>

<template>
	<div role="tablist" :aria-label="label" class="flex gap-6 overflow-x-auto overflow-y-hidden border-b border-border">
		<button
			v-for="(item, index) in items"
			:key="String(item.value)"
			ref="tabs"
			type="button"
			role="tab"
			:aria-selected="item.value === model"
			:tabindex="item.value === model ? 0 : -1"
			:data-testid="item.testId"
			class="relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 py-2.5 text-body-s font-medium transition-colors"
			:class="
				item.value === model
					? 'border-accent text-fg'
					: 'border-transparent text-fg-muted hover:text-fg'
			"
			@click="select(index)"
			@keydown="onKeydown($event, index)"
		>
			{{ item.label }}
			<span v-if="item.count !== undefined" class="text-fg-subtle" data-numeric>{{ item.count }}</span>
		</button>
	</div>
</template>
