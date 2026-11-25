<script setup lang="ts">
import { ref, toRef } from 'vue';
import { useModalDialog } from '../../composables/useModalDialog';

const open = defineModel<boolean>('open', { default: false });
defineProps<{ label: string }>();

const dialog = ref<HTMLDialogElement | null>(null);
const { onCancel, onBackdropClick } = useModalDialog(dialog, toRef(open), {
	onClose: () => {
		open.value = false;
	},
});
// Template note: Side panel for the mobile navigation: Esc, backdrop tap or navigating closes it. (no root comment, so attrs reach <dialog>)
</script>

<template>
	<dialog
		ref="dialog"
		:aria-label="label"
		class="m-0 h-dvh max-h-none w-[288px] max-w-[85vw] border-0 bg-transparent p-0 shadow-overlay"
		@cancel="onCancel"
		@click="onBackdropClick"
	>
		<slot :close="() => (open = false)" />
	</dialog>
</template>
