<script setup lang="ts">
// The big connection status at the top of an integration page
// (Figma: App/ConnectionHeader). Actions (Send test, Disconnect) go in the slot.
import { Check, CircleAlert, Clock, Plug } from 'lucide-vue-next';
import { computed } from 'vue';
import type { ConnectionState } from '../ui/UiStatus.vue';

const props = defineProps<{ state: ConnectionState; title: string; summary?: string }>();

const STATES = {
	connected: ['bg-success-bg text-success', Check],
	attention: ['bg-level-warning-bg text-level-warning', CircleAlert],
	pending: ['bg-level-info-bg text-level-info', Clock],
	off: ['bg-subtle text-fg-muted', Plug],
} as const;
const entry = computed(() => STATES[props.state] ?? STATES.off);
</script>

<template>
	<section
		class="flex flex-col gap-4 rounded-[10px] border border-border bg-surface px-5 py-4.5 sm:flex-row sm:items-center"
		:data-state="state"
		data-testid="connection-header"
		aria-live="polite"
	>
		<div class="flex min-w-0 flex-1 items-center gap-4">
			<span :class="['flex size-11 shrink-0 items-center justify-center rounded-full', entry[0]]">
				<component :is="entry[1]" :size="22" aria-hidden="true" />
			</span>
			<div class="min-w-0 flex-1">
				<h2 class="text-heading-m text-fg">{{ title }}</h2>
				<p v-if="summary" class="mt-0.5 text-body-s break-words text-fg-muted">{{ summary }}</p>
			</div>
		</div>
		<div v-if="$slots.actions" class="flex shrink-0 flex-wrap items-center gap-2">
			<slot name="actions" />
		</div>
	</section>
</template>
