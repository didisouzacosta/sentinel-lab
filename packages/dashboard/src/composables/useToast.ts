import { reactive } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
	action?: { label: string; onClick: () => void };
	/** ms before auto-dismiss; 0 keeps it until closed. */
	duration: number;
}

type ToastOptions = Partial<Pick<Toast, 'action' | 'duration'>>;

// Module-level queue rendered by <UiToaster> (mounted once in App.vue).
const state = reactive({ toasts: [] as Toast[] });
let nextId = 1;

const DEFAULT_DURATION: Record<ToastKind, number> = { success: 4000, info: 4000, error: 6000 };

function push(kind: ToastKind, message: string, options: ToastOptions = {}): number {
	const toast: Toast = {
		id: nextId++,
		kind,
		message,
		duration: DEFAULT_DURATION[kind],
		...options,
	};
	state.toasts.push(toast);
	// Keep the stack short: the oldest goes first.
	if (state.toasts.length > 4) state.toasts.shift();
	return toast.id;
}

function dismiss(id: number) {
	const i = state.toasts.findIndex((t) => t.id === id);
	if (i >= 0) state.toasts.splice(i, 1);
}

/** Replacement for alert() and silent console.error: short, announced, non-blocking feedback. */
export function useToast() {
	return {
		success: (message: string, options?: ToastOptions) => push('success', message, options),
		error: (message: string, options?: ToastOptions) => push('error', message, options),
		info: (message: string, options?: ToastOptions) => push('info', message, options),
		dismiss,
		clear: () => state.toasts.splice(0),
		toasts: state.toasts,
	};
}
