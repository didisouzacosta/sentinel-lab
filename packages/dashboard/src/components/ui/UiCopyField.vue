<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next';
import { onBeforeUnmount, ref } from 'vue';
import { useToast } from '../../composables/useToast';

const props = withDefaults(
	defineProps<{
		value: string;
		/** Accessible name of the value, e.g. "DSN". */
		label: string;
		/** Toast shown after copying. */
		copiedMessage?: string;
	}>(),
	{ copiedMessage: undefined },
);
const emit = defineEmits<{ copied: [] }>();

const toast = useToast();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
	try {
		await navigator.clipboard.writeText(props.value);
		copied.value = true;
		emit('copied');
		toast.success(props.copiedMessage ?? `${props.label} copied to clipboard`);
		clearTimeout(timer);
		timer = setTimeout(() => {
			copied.value = false;
		}, 2000);
	} catch {
		toast.error('Could not copy — select the text and copy it manually');
	}
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
	<div class="flex items-center gap-2">
		<output
			:aria-label="label"
			class="flex h-9 min-w-0 flex-1 items-center truncate rounded-lg border border-border bg-canvas px-3 font-mono text-body-s text-fg select-all"
		>
			{{ value }}
		</output>
		<button
			type="button"
			class="inline-flex h-9 w-[92px] shrink-0 items-center justify-center gap-1.5 rounded-lg border text-body-s font-medium transition-colors"
			:class="
				copied
					? 'border-success bg-success-bg text-success'
					: 'border-border-strong bg-raised text-fg hover:bg-subtle'
			"
			:aria-label="copied ? `${label} copied` : `Copy ${label}`"
			@click="copy"
		>
			<component :is="copied ? Check : Copy" :size="16" aria-hidden="true" />
			{{ copied ? 'Copied' : 'Copy' }}
		</button>
	</div>
</template>
