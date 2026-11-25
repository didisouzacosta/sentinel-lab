<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';
import { computed, useId } from 'vue';
import type { ResolvedFrame } from '../../lib/sourcemap-resolver';
import UiTag from '../ui/UiTag.vue';

export interface StackFrameData {
	filename?: string;
	function?: string;
	lineno?: number;
	colno?: number;
	context_line?: string;
	pre_context?: string[];
	post_context?: string[];
	in_app?: boolean;
}

const props = defineProps<{
	frame: StackFrameData;
	resolved?: ResolvedFrame;
	/** Show the source-mapped location when available. */
	showOriginal: boolean;
	expanded: boolean;
}>();
defineEmits<{ toggle: [] }>();

const contextId = `frame-ctx-${useId()}`;
const mapped = computed(() => props.showOriginal && props.resolved?.resolved);
const fn = computed(() =>
	mapped.value
		? props.resolved?.originalFunction || props.frame.function || '(anonymous)'
		: props.frame.function || '(anonymous)',
);
const file = computed(
	() => (mapped.value ? props.resolved?.originalFilename : props.frame.filename) ?? '',
);
const position = computed(() => {
	const line = mapped.value ? props.resolved?.originalLineno : props.frame.lineno;
	const col = mapped.value ? props.resolved?.originalColno : props.frame.colno;
	return `${line ? `:${line}` : ''}${col ? `:${col}` : ''}`;
});
const hasContext = computed(
	() =>
		!!(
			props.frame.context_line ||
			props.frame.pre_context?.length ||
			props.frame.post_context?.length
		),
);
const lines = computed(() => {
	const f = props.frame;
	const base = f.lineno ?? 0;
	const pre = (f.pre_context ?? []).map((code, i, all) => ({
		n: base - all.length + i,
		code,
		current: false,
	}));
	const cur =
		f.context_line !== undefined ? [{ n: base, code: f.context_line, current: true }] : [];
	const post = (f.post_context ?? []).map((code, i) => ({ n: base + i + 1, code, current: false }));
	return [...pre, ...cur, ...post];
});
const inApp = computed(() => props.frame.in_app !== false);
</script>

<template>
	<div class="border-b border-border last:border-b-0">
		<button
			type="button"
			class="flex w-full min-w-0 items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-raised"
			:class="expanded ? 'bg-raised' : ''"
			:aria-expanded="hasContext ? expanded : undefined"
			:aria-controls="hasContext ? contextId : undefined"
			@click="$emit('toggle')"
		>
			<ChevronRight
				:size="14"
				class="shrink-0 text-fg-subtle transition-transform"
				:class="[expanded ? 'rotate-90' : '', hasContext ? '' : 'invisible']"
				aria-hidden="true"
			/>
			<span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 font-mono text-body-s">
				<span class="min-w-0 truncate" :class="inApp ? 'text-fg' : 'text-fg-subtle'">{{ file }}</span>
				<span class="text-fg-subtle">{{ position }}</span>
				<span class="font-sans text-caption text-fg-subtle">in</span>
				<span class="min-w-0 truncate text-accent-text">{{ fn }}</span>
				<span v-if="mapped" class="font-sans text-caption text-success" title="Resolved via source map">mapped</span>
			</span>
			<UiTag v-if="inApp">in-app</UiTag>
		</button>
		<!-- Context lines: scroll horizontally inside the card, never the page -->
		<div
			v-if="expanded && hasContext"
			:id="contextId"
			class="overflow-x-auto bg-canvas py-1.5"
			tabindex="0"
			role="region"
			:aria-label="`Source around ${file}${position}`"
		>
			<pre class="min-w-max font-mono text-body-s leading-5"><code
				v-for="line in lines"
				:key="line.n"
				class="flex gap-4 px-4"
				:class="line.current ? 'bg-level-error-bg text-fg' : 'text-fg-muted'"
				:aria-current="line.current ? 'true' : undefined"
			><span class="w-8 shrink-0 text-right select-none" :class="line.current ? 'text-level-error' : 'text-fg-subtle'">{{ line.n }}</span><span>{{ line.code }}</span></code></pre>
		</div>
	</div>
</template>
