<script setup lang="ts">
import { ArrowUpRight } from 'lucide-vue-next';
import { type RouteLocationRaw, RouterLink } from 'vue-router';

defineProps<{
	label: string;
	value: string;
	/** Small line under the value, e.g. where the card leads. */
	hint?: string;
	/** Makes the whole card a link (to the filtered list). */
	to?: RouteLocationRaw;
}>();
</script>

<template>
	<component
		:is="to ? RouterLink : 'div'"
		:to="to"
		class="group flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-4 transition-colors"
		:class="to ? 'hover:border-accent/60 hover:bg-raised' : ''"
	>
		<span class="flex items-center gap-2">
			<span class="flex-1 text-body-s font-medium text-fg-muted">{{ label }}</span>
			<ArrowUpRight
				v-if="to"
				:size="14"
				class="text-fg-subtle transition-colors group-hover:text-accent-text"
				aria-hidden="true"
			/>
		</span>
		<span class="text-metric text-fg" data-numeric>{{ value }}</span>
		<span v-if="hint" class="text-caption text-fg-subtle">{{ hint }}</span>
	</component>
</template>
