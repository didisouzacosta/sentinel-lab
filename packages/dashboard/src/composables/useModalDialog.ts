import { onBeforeUnmount, type Ref, watch } from 'vue';

interface Options {
	/** Esc and backdrop click close the dialog (default true). */
	dismissible?: () => boolean;
	/** Asked before a user-initiated close; return false to keep it open (unsaved changes). */
	beforeClose?: () => boolean | Promise<boolean>;
	onClose: () => void;
}

let openCount = 0;

/**
 * Shared behaviour for every modal surface (UiDialog, UiConfirm, UiDrawer, sheets):
 * native <dialog>.showModal() gives the top layer, inert background and focus trap;
 * this adds focus restore, scroll lock, Esc/backdrop handling and a close guard.
 */
export function useModalDialog(
	dialog: Ref<HTMLDialogElement | null>,
	open: Ref<boolean>,
	options: Options,
) {
	let returnFocus: HTMLElement | null = null;

	function lockScroll(lock: boolean) {
		openCount = Math.max(0, openCount + (lock ? 1 : -1));
		document.documentElement.style.overflow = openCount > 0 ? 'hidden' : '';
	}

	function show() {
		const el = dialog.value;
		if (!el || el.open) return;
		returnFocus = document.activeElement as HTMLElement | null;
		if (typeof el.showModal === 'function') el.showModal();
		else el.setAttribute('open', '');
		lockScroll(true);
		// Prefer an element marked [autofocus]; otherwise the first focusable one.
		const target =
			el.querySelector<HTMLElement>('[autofocus]') ??
			el.querySelector<HTMLElement>(
				'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			);
		target?.focus();
	}

	function hide() {
		const el = dialog.value;
		if (!el) return;
		if (el.open) {
			if (typeof el.close === 'function') el.close();
			else el.removeAttribute('open');
			lockScroll(false);
		}
		returnFocus?.focus?.();
		returnFocus = null;
	}

	async function requestClose() {
		if (options.dismissible && !options.dismissible()) return;
		if (options.beforeClose && !(await options.beforeClose())) return;
		options.onClose();
	}

	function onCancel(event: Event) {
		// Esc: the browser would close the dialog itself; keep Vue state in charge.
		event.preventDefault();
		void requestClose();
	}

	function onBackdropClick(event: MouseEvent) {
		// Clicks on the ::backdrop are dispatched to the <dialog> element itself.
		if (event.target === dialog.value) void requestClose();
	}

	watch(
		[open, dialog],
		([isOpen, el]) => {
			if (!el) return;
			if (isOpen) show();
			else hide();
		},
		{ flush: 'post', immediate: true },
	);

	onBeforeUnmount(() => {
		if (dialog.value?.open) {
			lockScroll(false);
			returnFocus?.focus?.();
		}
	});

	return { onCancel, onBackdropClick, requestClose };
}
