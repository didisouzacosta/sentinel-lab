<script setup lang="ts">
import { Activity, CircleAlert, CircleCheck, X } from 'lucide-vue-next';
import { onBeforeUnmount, watch } from 'vue';
import { type Toast, useToast } from '../../composables/useToast';

const { toasts, dismiss } = useToast();

const ICON = {
	success: [CircleCheck, 'text-success'],
	error: [CircleAlert, 'text-level-error'],
	info: [Activity, 'text-level-info'],
} as const;

// Per-toast timers that pause while hovered or focused.
const timers = new Map<
	number,
	{ handle?: ReturnType<typeof setTimeout>; remaining: number; started: number }
>();

function start(toast: Toast) {
	if (!toast.duration) return;
	const t = timers.get(toast.id) ?? { remaining: toast.duration, started: 0 };
	t.started = Date.now();
	t.handle = setTimeout(() => close(toast.id), t.remaining);
	timers.set(toast.id, t);
}
function pause(toast: Toast) {
	const t = timers.get(toast.id);
	if (!t?.handle) return;
	clearTimeout(t.handle);
	t.handle = undefined;
	t.remaining -= Date.now() - t.started;
}
function close(id: number) {
	const t = timers.get(id);
	if (t?.handle) clearTimeout(t.handle);
	timers.delete(id);
	dismiss(id);
}
function runAction(toast: Toast) {
	toast.action?.onClick();
	close(toast.id);
}

watch(
	() => toasts.map((t) => t.id),
	() => {
		for (const toast of toasts) if (!timers.has(toast.id)) start(toast);
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	for (const t of timers.values()) if (t.handle) clearTimeout(t.handle);
});
</script>

<template>
	<!-- Bottom-right on desktop, top on phones. Polite live region: announced, never steals focus. -->
	<section
		aria-label="Notifications"
		aria-live="polite"
		class="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:top-auto sm:right-5 sm:bottom-5 sm:w-[380px]"
	>
		<TransitionGroup
			enter-from-class="translate-y-2 opacity-0"
			enter-active-class="transition duration-150 ease-out"
			leave-to-class="opacity-0"
			leave-active-class="transition duration-150 ease-in"
		>
			<div
				v-for="toast in toasts"
				:key="toast.id"
				:role="toast.kind === 'error' ? 'alert' : 'status'"
				class="pointer-events-auto flex items-center gap-2.5 rounded-[10px] border border-border-strong bg-raised py-3 pr-2.5 pl-3.5 shadow-overlay"
				data-testid="toast"
				@mouseenter="pause(toast)"
				@mouseleave="start(toast)"
				@focusin="pause(toast)"
				@focusout="start(toast)"
			>
				<component :is="ICON[toast.kind][0]" :size="18" :class="['shrink-0', ICON[toast.kind][1]]" aria-hidden="true" />
				<p class="min-w-0 flex-1 text-body-s font-medium text-fg">{{ toast.message }}</p>
				<button
					v-if="toast.action"
					type="button"
					class="shrink-0 text-body-s font-medium text-accent-text hover:underline"
					@click="runAction(toast)"
				>
					{{ toast.action.label }}
				</button>
				<button
					type="button"
					class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
					aria-label="Dismiss notification"
					@click="close(toast.id)"
				>
					<X :size="14" aria-hidden="true" />
				</button>
			</div>
		</TransitionGroup>
	</section>
</template>
