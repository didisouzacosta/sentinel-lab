<script setup lang="ts">
// A link to another site, opened in a new tab (Figma: ExternalLink).
// `disabled` (or no href) renders it inert, e.g. until a URL is typed.
import { ExternalLink } from 'lucide-vue-next';
import { computed } from 'vue';

const props = withDefaults(
	defineProps<{
		href?: string | null;
		variant?: 'inline' | 'button';
		disabled?: boolean;
	}>(),
	{ variant: 'inline' },
);

const inert = computed(() => props.disabled || !props.href);
const classes = computed(() =>
	props.variant === 'button'
		? 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-strong bg-raised px-3.5 text-body-s font-medium whitespace-nowrap text-fg transition-colors hover:bg-subtle'
		: 'inline-flex items-center gap-1 text-body-s font-medium text-accent-text hover:underline',
);
</script>

<template>
	<span v-if="inert" :class="[classes, 'pointer-events-none opacity-45']" aria-disabled="true">
		<slot />
		<ExternalLink :size="14" :class="variant === 'button' ? 'text-fg-muted' : ''" aria-hidden="true" />
	</span>
	<a v-else :href="href!" target="_blank" rel="noopener noreferrer" :class="classes">
		<slot />
		<ExternalLink :size="14" :class="variant === 'button' ? 'text-fg-muted' : ''" aria-hidden="true" />
		<span class="sr-only">(opens in a new tab)</span>
	</a>
</template>
