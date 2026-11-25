<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { ref, toRef, useId } from 'vue';
import { useModalDialog } from '../../composables/useModalDialog';
import { cn } from '../../lib/cn';

const open = defineModel<boolean>('open', { default: false });

const props = withDefaults(
	defineProps<{
		title: string;
		description?: string;
		/** Esc / backdrop / × close the dialog (default true). */
		dismissible?: boolean;
		/** Asked before closing via Esc/backdrop/×; return false to keep it open. */
		beforeClose?: () => boolean | Promise<boolean>;
		size?: 'sm' | 'md' | 'lg';
		/** Wrap the body in a <form>; `submit` fires on Enter / primary button. */
		form?: boolean;
		class?: string;
	}>(),
	{ dismissible: true, size: 'md', form: false },
);
const emit = defineEmits<{ submit: []; close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const uid = useId();
const titleId = `dialog-title-${uid}`;
const descId = `dialog-desc-${uid}`;

const { onCancel, onBackdropClick, requestClose } = useModalDialog(dialog, toRef(open), {
	dismissible: () => props.dismissible,
	beforeClose: props.beforeClose,
	onClose: () => {
		open.value = false;
		emit('close');
	},
});

const WIDTH = { sm: 'sm:max-w-[400px]', md: 'sm:max-w-[480px]', lg: 'sm:max-w-[640px]' };
</script>

<template>
	<!-- Centered on desktop; bottom sheet below 640px. -->
	<dialog
		ref="dialog"
		:aria-labelledby="titleId"
		:aria-describedby="description ? descId : undefined"
		:class="
			cn(
				'm-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl border border-border-strong bg-raised p-0 text-fg shadow-overlay',
				'sm:m-auto sm:max-h-[85dvh] sm:rounded-xl',
				WIDTH[size],
				props.class,
			)
		"
		@cancel="onCancel"
		@click="onBackdropClick"
	>
		<component
			:is="form ? 'form' : 'div'"
			class="flex max-h-[inherit] flex-col"
			@submit.prevent="form && emit('submit')"
		>
			<div class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong sm:hidden" aria-hidden="true" />
			<header class="flex items-start gap-3 pt-4 pr-3.5 pb-1 pl-5">
				<div class="min-w-0 flex-1">
					<h2 :id="titleId" class="text-heading-m text-fg">{{ title }}</h2>
					<p v-if="description" :id="descId" class="mt-1 text-body-s text-fg-muted">{{ description }}</p>
				</div>
				<button
					v-if="dismissible"
					type="button"
					class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
					aria-label="Close"
					@click="requestClose"
				>
					<X :size="16" aria-hidden="true" />
				</button>
			</header>
			<div class="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
				<slot />
			</div>
			<footer
				v-if="$slots.footer"
				class="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-surface px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end"
			>
				<slot name="footer" :close="requestClose" />
			</footer>
		</component>
	</dialog>
</template>
