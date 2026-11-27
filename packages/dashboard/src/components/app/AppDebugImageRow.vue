<script setup lang="ts">
import { computed } from 'vue';

/** One image of a crash and whether its debug file is stored. */
const props = defineProps<{
	image: string;
	debugId: string;
	arch?: string | null;
	status: 'found' | 'missing' | 'processing';
}>();

const STATUS = {
	found: ['Found', 'bg-success-bg text-success', 'bg-success'],
	missing: ['Missing', 'bg-level-warning-bg text-level-warning', 'bg-level-warning'],
	processing: ['Processing', 'bg-subtle text-fg-muted', 'bg-fg-muted'],
} as const;
const look = computed(() => STATUS[props.status]);
</script>

<template>
	<li class="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
		<div class="min-w-0 flex-1">
			<p class="truncate font-mono text-body-s text-fg">{{ image }}</p>
			<p class="truncate text-caption text-fg-subtle">{{ debugId }}{{ arch ? ` · ${arch}` : '' }}</p>
		</div>
		<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption" :class="look[1]">
			<span class="size-1.5 rounded-full" :class="look[2]" aria-hidden="true" />
			{{ look[0] }}
		</span>
	</li>
</template>
