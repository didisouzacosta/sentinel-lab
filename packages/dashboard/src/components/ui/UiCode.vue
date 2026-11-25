<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next';
import { onBeforeUnmount, ref } from 'vue';
import { useToast } from '../../composables/useToast';

const props = defineProps<{ code: string; language?: string }>();

const toast = useToast();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
	try {
		await navigator.clipboard.writeText(props.code);
		copied.value = true;
		toast.success('Copied to clipboard');
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
	<figure class="overflow-hidden rounded-lg border border-border bg-canvas">
		<figcaption class="flex items-center gap-2 border-b border-border py-1.5 pr-2 pl-3">
			<span class="flex-1 text-caption text-fg-subtle">{{ language ?? 'Code' }}</span>
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-caption text-fg-muted hover:bg-subtle hover:text-fg"
				:aria-label="copied ? 'Copied' : `Copy ${language ?? 'code'}`"
				@click="copy"
			>
				<component :is="copied ? Check : Copy" :size="14" aria-hidden="true" />
				{{ copied ? 'Copied' : 'Copy' }}
			</button>
		</figcaption>
		<!-- Focusable scroll region: long lines scroll sideways, keyboard users included -->
		<div class="overflow-x-auto" tabindex="0" role="region" :aria-label="`${language ?? 'Code'} snippet`">
			<pre class="w-max min-w-full px-3.5 py-3 text-body-s leading-5 text-fg"><code>{{ code }}</code></pre>
		</div>
	</figure>
</template>
