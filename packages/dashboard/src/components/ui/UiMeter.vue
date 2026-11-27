<script setup lang="ts">
import { computed } from 'vue';

/** Usage bar for a quota or budget: accent below 80 %, warning from 80 %, error at 100 %. */
const props = defineProps<{ value: number; max: number; label: string }>();

const percent = computed(() =>
	props.max > 0 ? Math.min(100, Math.round((props.value / props.max) * 100)) : 0,
);
const tone = computed(() =>
	percent.value >= 100 ? 'bg-level-error' : percent.value >= 80 ? 'bg-level-warning' : 'bg-accent',
);
</script>

<template>
	<div
		class="h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-subtle"
		role="meter"
		:aria-label="label"
		:aria-valuenow="value"
		aria-valuemin="0"
		:aria-valuemax="max"
	>
		<div class="h-full rounded-full" :class="tone" :style="{ width: `${percent}%` }" />
	</div>
</template>
