<script setup lang="ts">
// On/off toggle for settings that apply immediately (Figma: Switch).
// A <button role="switch"> so Space/Enter toggle it and screen readers
// announce "on/off"; pass `label` when there is no visible label next to it.
const model = defineModel<boolean>({ default: false });

defineProps<{
	/** Accessible name when no visible label is associated. */
	label?: string;
	disabled?: boolean;
}>();
</script>

<template>
	<button
		type="button"
		role="switch"
		:aria-checked="model"
		:aria-label="label"
		:disabled="disabled"
		class="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-60"
		:class="model ? 'bg-accent' : 'bg-border-strong'"
		@click="model = !model"
	>
		<span
			class="pointer-events-none block size-3.5 rounded-full bg-white shadow-sm transition-transform"
			:class="model ? 'translate-x-[15px]' : 'translate-x-px'"
			aria-hidden="true"
		/>
	</button>
</template>
