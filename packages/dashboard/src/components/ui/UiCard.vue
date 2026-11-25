<script setup lang="ts">
import { useId } from 'vue';
import { cn } from '../../lib/cn';

const props = withDefaults(
	defineProps<{
		/** Card title (rendered as a heading, linked to the section by aria-labelledby). */
		title?: string;
		/** Small text on the right of the header. */
		meta?: string;
		/** Heading level for the title. */
		headingLevel?: 2 | 3;
		/** Adds padding around the default slot. */
		padded?: boolean;
		tone?: 'default' | 'danger';
		as?: string;
		class?: string;
	}>(),
	{ headingLevel: 2, padded: false, tone: 'default', as: 'section' },
);

const titleId = `card-${useId()}`;
</script>

<template>
	<component
		:is="as"
		:aria-labelledby="title ? titleId : undefined"
		:class="
			cn(
				'overflow-hidden rounded-[10px] border bg-surface',
				tone === 'danger' ? 'border-level-error' : 'border-border',
				props.class,
			)
		"
	>
		<header
			v-if="title || $slots.header || $slots.actions"
			class="flex min-h-11 items-center gap-2 border-b border-border px-4 py-2.5"
		>
			<slot name="header">
				<component
					:is="`h${headingLevel}`"
					:id="titleId"
					:class="['flex-1 text-heading-s', tone === 'danger' ? 'text-level-error' : 'text-fg']"
>{{ title }}</component>
				<span v-if="meta" class="text-caption text-fg-subtle">{{ meta }}</span>
			</slot>
			<slot name="actions" />
		</header>
		<div v-if="padded" class="px-4 py-4">
			<slot />
		</div>
		<slot v-else />
	</component>
</template>
