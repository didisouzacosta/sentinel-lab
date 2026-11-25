import { reactive } from 'vue';

export interface ConfirmOptions {
	title: string;
	description?: string;
	/** Verb + object, e.g. "Delete 2 issues". */
	confirmLabel?: string;
	cancelLabel?: string;
	tone?: 'default' | 'danger';
	/** For high-impact actions: the user must type this text to enable confirm. */
	requireText?: string;
	/** Optional bullet list of affected items shown in the dialog. */
	items?: string[];
}

interface PendingConfirm extends ConfirmOptions {
	resolve: (ok: boolean) => void;
}

// One confirm at a time, rendered by <UiConfirmHost> (mounted once in App.vue).
export const confirmState = reactive<{ current: PendingConfirm | null }>({ current: null });

/** Promise-based replacement for window.confirm(). Resolves true on confirm, false otherwise. */
export function useConfirm() {
	return function confirm(options: ConfirmOptions): Promise<boolean> {
		confirmState.current?.resolve(false);
		return new Promise<boolean>((resolve) => {
			confirmState.current = {
				tone: 'default',
				cancelLabel: 'Cancel',
				confirmLabel: 'Confirm',
				...options,
				resolve,
			};
		});
	};
}

export function settleConfirm(ok: boolean) {
	const pending = confirmState.current;
	confirmState.current = null;
	pending?.resolve(ok);
}
