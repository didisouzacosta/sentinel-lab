<script setup lang="ts">
import { Activity, CircleAlert, CircleCheck, TriangleAlert } from 'lucide-vue-next';
import { computed } from 'vue';

const props = withDefaults(
	defineProps<{
		tone?: 'error' | 'warning' | 'info' | 'success';
		/** Label of the inline action ("Try again"); emits `action`. */
		actionLabel?: string;
	}>(),
	{ tone: 'info' },
);
defineEmits<{ action: [] }>();

const TONES = {
	error: ['bg-level-error-bg', 'text-level-error', CircleAlert],
	warning: ['bg-level-warning-bg', 'text-level-warning', TriangleAlert],
	info: ['bg-level-info-bg', 'text-level-info', Activity],
	success: ['bg-success-bg', 'text-success', CircleCheck],
} as const;
const tone = computed(() => TONES[props.tone]);
</script>

<template>
	<div
		:role="props.tone === 'error' ? 'alert' : 'status'"
		:class="['flex items-start gap-2.5 rounded-lg px-3.5 py-2.5', tone[0]]"
	>
		<component :is="tone[2]" :size="16" :class="['mt-px shrink-0', tone[1]]" aria-hidden="true" />
		<div class="min-w-0 flex-1 text-body-s text-fg"><slot /></div>
		<button
			v-if="actionLabel"
			type="button"
			:class="['shrink-0 text-body-s font-medium hover:underline', tone[1]]"
			@click="$emit('action')"
		>
			{{ actionLabel }}
		</button>
	</div>
</template>
