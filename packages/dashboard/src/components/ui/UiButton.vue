<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-vue-next';
import { type Component, computed } from 'vue';
import { type RouteLocationRaw, RouterLink } from 'vue-router';
import { cn } from '../../lib/cn';

const button = cva(
	'inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
	{
		variants: {
			variant: {
				primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
				secondary: 'border border-border-strong bg-raised text-fg hover:bg-subtle',
				ghost: 'text-fg-muted hover:bg-subtle hover:text-fg',
				danger: 'bg-level-error-bg text-level-error hover:bg-level-error hover:text-accent-fg',
			},
			size: {
				md: 'h-9 rounded-lg px-3.5 text-body-s',
				sm: 'h-7 rounded-md px-2.5 text-caption',
				icon: 'size-9 rounded-lg',
				'icon-sm': 'size-7 rounded-md',
			},
		},
		defaultVariants: { variant: 'secondary', size: 'md' },
	},
);

type ButtonVariants = VariantProps<typeof button>;

const props = withDefaults(
	defineProps<{
		variant?: NonNullable<ButtonVariants['variant']>;
		size?: NonNullable<ButtonVariants['size']>;
		/** Leading icon (a lucide component). */
		icon?: Component;
		/** Shows a spinner, sets aria-busy and blocks clicks. */
		loading?: boolean;
		disabled?: boolean;
		type?: 'button' | 'submit' | 'reset';
		/** Renders a RouterLink instead of a <button>. */
		to?: RouteLocationRaw;
		class?: string;
	}>(),
	{ variant: 'secondary', size: 'md', type: 'button' },
);

const classes = computed(() =>
	cn(button({ variant: props.variant, size: props.size }), props.class),
);
const iconSize = computed(() => (props.size === 'sm' || props.size === 'icon-sm' ? 14 : 16));
</script>

<template>
	<RouterLink
		v-if="to"
		:to="to"
		:class="classes"
		:aria-disabled="disabled || loading || undefined"
		:aria-busy="loading || undefined"
	>
		<LoaderCircle v-if="loading" :size="iconSize" class="animate-spin" aria-hidden="true" />
		<component :is="icon" v-else-if="icon" :size="iconSize" aria-hidden="true" />
		<slot />
	</RouterLink>
	<button
		v-else
		:type="type"
		:class="classes"
		:disabled="disabled || loading"
		:aria-busy="loading || undefined"
	>
		<LoaderCircle v-if="loading" :size="iconSize" class="animate-spin" aria-hidden="true" />
		<component :is="icon" v-else-if="icon" :size="iconSize" aria-hidden="true" />
		<slot />
	</button>
</template>
