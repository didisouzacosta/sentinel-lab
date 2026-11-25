<script setup lang="ts">
withDefaults(
	defineProps<{
		/** row = table row placeholder; line = single text line; block = free box. */
		variant?: 'row' | 'line' | 'block';
		/** How many rows/lines to render. */
		count?: number;
		/** Accessible label announced while loading. */
		label?: string;
	}>(),
	{ variant: 'row', count: 1, label: 'Loading' },
);
</script>

<template>
	<div role="status" :aria-label="label" aria-live="polite">
		<template v-if="variant === 'row'">
			<div
				v-for="i in count"
				:key="i"
				class="flex items-center gap-4 border-b border-border bg-surface px-4 py-3.5 last:border-b-0"
			>
				<div class="flex flex-1 flex-col gap-2">
					<span class="h-2.5 w-2/5 animate-pulse-soft rounded-full bg-subtle" />
					<span class="h-2.5 w-1/4 animate-pulse-soft rounded-full bg-subtle" />
				</div>
				<span class="h-2.5 w-16 animate-pulse-soft rounded-full bg-subtle" />
				<span class="h-2.5 w-12 animate-pulse-soft rounded-full bg-subtle" />
				<span class="h-2.5 w-12 animate-pulse-soft rounded-full bg-subtle" />
			</div>
		</template>
		<template v-else-if="variant === 'line'">
			<span v-for="i in count" :key="i" class="mb-2 block h-2.5 animate-pulse-soft rounded-full bg-subtle last:mb-0" />
		</template>
		<span v-else class="block h-full min-h-16 w-full animate-pulse-soft rounded-lg bg-subtle" />
		<span class="sr-only">{{ label }}…</span>
	</div>
</template>
