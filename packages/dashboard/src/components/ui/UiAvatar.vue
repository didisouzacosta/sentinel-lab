<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name?: string | null; size?: 'sm' | 'md' }>(), {
	size: 'md',
});
const initial = computed(() => (props.name?.trim().charAt(0) || '?').toUpperCase());
</script>

<template>
	<span
		:class="[
			'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-subtle font-medium text-accent-text',
			size === 'sm' ? 'size-6 text-[11px]' : 'size-7 text-caption',
		]"
		aria-hidden="true"
	>
		{{ initial }}
	</span>
</template>
