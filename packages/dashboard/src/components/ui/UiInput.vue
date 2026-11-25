<script setup lang="ts">
import type { Component } from 'vue';
import { cn } from '../../lib/cn';

defineOptions({ inheritAttrs: false });

const model = defineModel<string | number | null>();

const props = defineProps<{
	/** Leading icon inside the field. */
	icon?: Component;
	invalid?: boolean;
	/** Renders a <textarea> (rows via attrs). */
	multiline?: boolean;
	class?: string;
}>();

const field =
	'w-full rounded-lg border border-border-strong bg-canvas text-body-s text-fg placeholder:text-fg-subtle hover:border-fg-subtle transition-shadow outline-none focus:border-accent focus:ring-3 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-level-error aria-invalid:focus:ring-level-error/25';
</script>

<template>
	<div :class="cn('relative', props.class)">
		<component
			:is="icon"
			v-if="icon"
			:size="16"
			class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle"
			aria-hidden="true"
		/>
		<textarea
			v-if="multiline"
			v-model="model"
			v-bind="$attrs"
			:aria-invalid="invalid || undefined"
			:class="cn(field, 'min-h-[72px] px-3 py-2 leading-relaxed')"
		/>
		<input
			v-else
			v-model="model"
			v-bind="$attrs"
			:aria-invalid="invalid || undefined"
			:class="cn(field, 'h-9 px-3', icon && 'pl-9')"
		/>
	</div>
</template>
