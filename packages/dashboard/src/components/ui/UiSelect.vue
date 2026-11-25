<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next';
import { cn } from '../../lib/cn';

defineOptions({ inheritAttrs: false });

const model = defineModel<string | number | null>();

const props = defineProps<{
	invalid?: boolean;
	class?: string;
}>();
</script>

<template>
	<div :class="cn('relative inline-flex', props.class)">
		<select
			v-model="model"
			v-bind="$attrs"
			:aria-invalid="invalid || undefined"
			class="h-9 w-full appearance-none rounded-lg border border-border-strong bg-canvas pr-9 pl-3 hover:border-fg-subtle text-body-s text-fg transition-shadow outline-none focus:border-accent focus:ring-3 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-level-error"
		>
			<slot />
		</select>
		<ChevronDown
			:size="16"
			class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-subtle"
			aria-hidden="true"
		/>
	</div>
</template>
