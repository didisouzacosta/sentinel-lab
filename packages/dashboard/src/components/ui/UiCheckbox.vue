<script setup lang="ts">
import { ref, watchEffect } from 'vue';

defineOptions({ inheritAttrs: false });

const model = defineModel<boolean>({ default: false });
const props = defineProps<{ indeterminate?: boolean; label?: string }>();

const input = ref<HTMLInputElement | null>(null);
// `indeterminate` is a DOM property only (no HTML attribute).
watchEffect(() => {
	if (input.value) input.value.indeterminate = !!props.indeterminate;
});
</script>

<template>
	<label v-if="label" class="inline-flex cursor-pointer items-center gap-2 text-body-s text-fg">
		<input
			ref="input"
			v-model="model"
			v-bind="$attrs"
			type="checkbox"
			class="size-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent"
		/>
		<span>{{ label }}</span>
	</label>
	<input
		v-else
		ref="input"
		v-model="model"
		v-bind="$attrs"
		type="checkbox"
		class="size-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent"
	/>
</template>
