<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { type ConfirmOptions, confirmState, settleConfirm } from '../../composables/useConfirm';
import UiButton from './UiButton.vue';
import UiDialog from './UiDialog.vue';
import UiInput from './UiInput.vue';

// The dialog stays mounted and keeps showing the last request while it closes,
// so focus returns to the trigger and the scroll lock is released properly.
const view = ref<ConfirmOptions | null>(null);
const typed = ref('');

watch(
	() => confirmState.current,
	(next) => {
		if (next) {
			view.value = next;
			typed.value = '';
		}
	},
);

const open = computed({
	get: () => !!confirmState.current,
	set: (v) => {
		if (!v) settleConfirm(false);
	},
});
const canConfirm = computed(
	() => !view.value?.requireText || typed.value === view.value.requireText,
);
</script>

<template>
	<UiDialog
		v-model:open="open"
		:title="view?.title ?? ''"
		:description="view?.description"
		size="sm"
		data-testid="confirm-dialog"
	>
		<ul
			v-if="view?.items?.length"
			class="flex flex-col gap-1.5 rounded-lg border border-border bg-canvas px-3 py-2.5 font-mono text-caption text-fg-muted"
		>
			<li v-for="item in view.items" :key="item" class="truncate">{{ item }}</li>
		</ul>
		<label v-if="view?.requireText" class="mt-3 flex flex-col gap-1.5 text-body-s text-fg">
			<span>Type <strong class="font-mono">{{ view.requireText }}</strong> to confirm</span>
			<UiInput v-model="typed" autocomplete="off" data-testid="confirm-dialog-input" />
		</label>
		<template #footer>
			<!-- Focus starts on Cancel: the safe choice for destructive actions. -->
			<UiButton variant="ghost" autofocus data-testid="confirm-dialog-cancel" @click="settleConfirm(false)">
				{{ view?.cancelLabel ?? 'Cancel' }}
			</UiButton>
			<UiButton
				:variant="view?.tone === 'danger' ? 'danger' : 'primary'"
				:disabled="!canConfirm"
				data-testid="confirm-dialog-confirm"
				@click="settleConfirm(true)"
			>
				{{ view?.confirmLabel ?? 'Confirm' }}
			</UiButton>
		</template>
	</UiDialog>
</template>
