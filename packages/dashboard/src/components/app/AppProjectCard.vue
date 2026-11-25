<script setup lang="ts">
import { computed } from 'vue';
import { type RouteLocationRaw, RouterLink } from 'vue-router';
import UiTag from '../ui/UiTag.vue';

const props = defineProps<{
	name: string;
	slug: string;
	platform: string;
	createdAt?: string;
	to: RouteLocationRaw;
}>();

// Stable brand color per project, derived from its slug (Figma variant "tone").
const TONES = [
	'bg-level-info-bg text-level-info',
	'bg-level-warning-bg text-level-warning',
	'bg-success-bg text-success',
	'bg-level-fatal-bg text-level-fatal',
	'bg-accent-subtle text-accent-text',
];
const tone = computed(() => {
	let hash = 0;
	for (const ch of props.slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return TONES[hash % TONES.length];
});
const initial = computed(() => (props.name.trim().charAt(0) || '?').toUpperCase());
const created = computed(() =>
	props.createdAt
		? new Date(props.createdAt).toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
			})
		: null,
);
</script>

<template>
	<RouterLink
		:to="to"
		class="group flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-5 transition-colors hover:border-accent/60 hover:bg-raised"
	>
		<div class="flex items-center gap-3">
			<span :class="['flex size-9 shrink-0 items-center justify-center rounded-lg text-heading-s', tone]" aria-hidden="true">
				{{ initial }}
			</span>
			<div class="min-w-0 flex-1">
				<h2 class="truncate text-heading-s text-fg group-hover:text-accent-text">{{ name }}</h2>
				<p class="truncate font-mono text-caption text-fg-subtle">{{ slug }}</p>
			</div>
			<UiTag>{{ platform }}</UiTag>
		</div>
		<p v-if="created" class="border-t border-border pt-3 text-caption text-fg-subtle">Created {{ created }}</p>
	</RouterLink>
</template>
