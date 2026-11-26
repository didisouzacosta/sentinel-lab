<script setup lang="ts">
// One integration on the Integrations overview (Figma: App/IntegrationCard).
// Cards in a grid share the same height; the footer stays at the bottom.
import type { Component } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import UiButton from '../ui/UiButton.vue';
import UiStatus, { type ConnectionState } from '../ui/UiStatus.vue';

defineProps<{
	name: string;
	description: string;
	icon: Component;
	/** Omitted when the viewer cannot see the status (members). */
	state?: ConnectionState;
	summary: string;
	to?: RouteLocationRaw;
	actionLabel?: string;
	actionVariant?: 'primary' | 'secondary';
}>();
</script>

<template>
	<article class="flex h-full flex-col gap-3 rounded-[10px] border border-border bg-surface p-4" :aria-label="name">
		<div class="flex items-center gap-3">
			<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
				<component :is="icon" :size="20" aria-hidden="true" />
			</span>
			<h2 class="min-w-0 flex-1 truncate text-heading-s text-fg">{{ name }}</h2>
			<UiStatus v-if="state" :state="state" />
		</div>
		<p class="flex-1 text-body-s text-fg-muted">{{ description }}</p>
		<div class="flex items-center gap-3">
			<p class="min-w-0 flex-1 truncate text-body-s text-fg-muted" :title="summary">{{ summary }}</p>
			<UiButton v-if="to && actionLabel" :to="to" size="sm" :variant="actionVariant ?? 'secondary'">
				{{ actionLabel }}
			</UiButton>
		</div>
	</article>
</template>
