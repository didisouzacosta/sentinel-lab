<script setup lang="ts">
// One numbered setup step (Figma: App/SetupStep). Use inside an
// <ol class="divide-y divide-border">. `current` shows the default slot;
// `done` shows a ✓ and the description as its summary (plus `actions`,
// e.g. Change); `locked` says which step comes first.
import { Check } from 'lucide-vue-next';
import { ref, useId } from 'vue';

const props = defineProps<{
	number: number;
	title: string;
	description?: string;
	state: 'current' | 'done' | 'locked';
	/** Shown instead of the description while locked. */
	lockedHint?: string;
}>();

const titleId = `step-${useId()}`;
const heading = ref<HTMLElement | null>(null);

/** Moves focus to the step title (after the previous step completes). */
function focus() {
	heading.value?.focus();
}
defineExpose({ focus });
</script>

<template>
	<li
		class="flex flex-col gap-3.5 px-5 py-4.5"
		:aria-labelledby="titleId"
		:aria-current="state === 'current' ? 'step' : undefined"
		:aria-disabled="state === 'locked' || undefined"
		:data-state="state"
	>
		<div class="flex items-start gap-3.5">
			<span
				:class="[
					'flex size-6 shrink-0 items-center justify-center rounded-full text-caption font-medium',
					state === 'done' ? 'bg-success-bg text-success' : state === 'locked' ? 'bg-subtle text-fg-subtle' : 'bg-accent-subtle text-accent-text',
				]"
			>
				<Check v-if="state === 'done'" :size="14" aria-label="Done" />
				<template v-else>{{ number }}</template>
			</span>
			<div class="min-w-0 flex-1">
				<h3
					:id="titleId"
					ref="heading"
					tabindex="-1"
					:class="['text-heading-s outline-none', state === 'locked' ? 'text-fg-subtle' : 'text-fg']"
				>
					{{ title }}
				</h3>
				<p
					v-if="state === 'locked' ? props.lockedHint : description"
					:class="['mt-0.5 text-body-s break-words', state === 'locked' ? 'text-fg-subtle' : 'text-fg-muted']"
				>
					{{ state === 'locked' ? props.lockedHint : description }}
				</p>
			</div>
			<div v-if="state === 'done' && $slots.actions" class="shrink-0">
				<slot name="actions" />
			</div>
		</div>
		<div v-if="state === 'current'" class="flex flex-col gap-3 sm:pl-[38px]">
			<slot />
		</div>
	</li>
</template>
