<script setup lang="ts">
import { X } from 'lucide-vue-next';

withDefaults(
	defineProps<{
		/** neutral = mono metadata (platform, env, tag:value); accent = active filter chip. */
		tone?: 'neutral' | 'accent';
		/** Shows a remove button (filter chips). */
		removable?: boolean;
		removeLabel?: string;
	}>(),
	{ tone: 'neutral', removeLabel: 'Remove' },
);
defineEmits<{ remove: [] }>();
</script>

<template>
	<span
		v-if="tone === 'accent'"
		class="inline-flex h-6 items-center gap-1 rounded-full bg-accent-subtle pr-1 pl-2.5 text-caption font-medium text-accent-text"
	>
		<slot />
		<button
			v-if="removable"
			type="button"
			class="inline-flex size-5 items-center justify-center rounded-full hover:bg-accent/20"
			:aria-label="removeLabel"
			@click="$emit('remove')"
		>
			<X :size="12" aria-hidden="true" />
		</button>
	</span>
	<span
		v-else
		class="inline-flex h-5 items-center gap-1 rounded bg-subtle px-1.5 font-mono text-caption text-fg-muted"
	>
		<slot />
		<button
			v-if="removable"
			type="button"
			class="inline-flex size-4 items-center justify-center rounded hover:bg-border"
			:aria-label="removeLabel"
			@click="$emit('remove')"
		>
			<X :size="12" aria-hidden="true" />
		</button>
	</span>
</template>
