<script setup lang="ts" generic="T extends string | number">
import { nextTick, ref } from 'vue';

const props = defineProps<{ options: { value: T; label: string }[]; label: string }>();
const model = defineModel<T>({ required: true });
const buttons = ref<HTMLButtonElement[]>([]);

async function onKeydown(event: KeyboardEvent, index: number) {
	const last = props.options.length - 1;
	let next = -1;
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
		next = index === last ? 0 : index + 1;
	if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
	if (next < 0) return;
	event.preventDefault();
	model.value = props.options[next].value;
	await nextTick();
	buttons.value[next]?.focus();
}
</script>

<template>
	<div role="radiogroup" :aria-label="label" class="inline-flex gap-0.5 rounded-lg bg-subtle p-0.5">
		<button
			v-for="(option, index) in options"
			:key="String(option.value)"
			ref="buttons"
			type="button"
			role="radio"
			:aria-checked="option.value === model"
			:tabindex="option.value === model ? 0 : -1"
			class="rounded-md px-2.5 py-1 text-caption font-medium transition-colors"
			:class="option.value === model ? 'bg-raised text-fg shadow-xs' : 'text-fg-muted hover:text-fg'"
			@click="model = option.value"
			@keydown="onKeydown($event, index)"
		>
			{{ option.label }}
		</button>
	</div>
</template>
