<script setup lang="ts">
// Connection status of an integration (Figma: Status).
import { Check, CircleAlert, Clock } from 'lucide-vue-next';
import { computed } from 'vue';

export type ConnectionState = 'connected' | 'pending' | 'attention' | 'off';

const props = defineProps<{
	state: ConnectionState;
	/** Overrides the default label of the state. */
	label?: string;
}>();

const STATES = {
	connected: ['bg-success-bg text-success', 'Connected', Check],
	pending: ['bg-level-info-bg text-level-info', 'Setup incomplete', Clock],
	attention: ['bg-level-warning-bg text-level-warning', 'Needs attention', CircleAlert],
	off: ['bg-subtle text-fg-muted', 'Not connected', null],
} as const;

const entry = computed(() => STATES[props.state] ?? STATES.off);
</script>

<template>
	<span
		:class="['inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-caption font-medium whitespace-nowrap', entry[0]]"
		:data-state="state"
	>
		<component :is="entry[2]" v-if="entry[2]" :size="12" aria-hidden="true" />
		<span v-else class="size-1.5 rounded-full bg-current" aria-hidden="true" />
		{{ label ?? entry[1] }}
	</span>
</template>
