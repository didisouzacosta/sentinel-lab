import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import UiButton from '../components/ui/UiButton.vue';
import UiConfirmHost from '../components/ui/UiConfirmHost.vue';
import UiCopyField from '../components/ui/UiCopyField.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiFormField from '../components/ui/UiFormField.vue';
import UiInput from '../components/ui/UiInput.vue';
import UiMenu from '../components/ui/UiMenu.vue';
import UiTabs from '../components/ui/UiTabs.vue';
import UiToaster from '../components/ui/UiToaster.vue';
import { confirmState, useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';

afterEach(() => {
	useToast().clear();
	confirmState.current = null;
	document.body.innerHTML = '';
	document.documentElement.style.overflow = '';
	vi.useRealTimers();
});

describe('UiButton', () => {
	it('renders variants and blocks clicks while loading', async () => {
		const onClick = vi.fn();
		const wrapper = mount(UiButton, {
			props: { variant: 'primary', loading: true, onClick },
			slots: { default: 'Save' },
		});
		const btn = wrapper.get('button');
		expect(btn.classes()).toContain('bg-accent');
		expect(btn.attributes('aria-busy')).toBe('true');
		expect(btn.attributes('disabled')).toBeDefined();
		await btn.trigger('click');
		expect(onClick).not.toHaveBeenCalled();
	});

	it('lets a caller class override variant utilities', () => {
		const wrapper = mount(UiButton, { props: { class: 'h-11' }, slots: { default: 'Go' } });
		expect(wrapper.get('button').classes()).toContain('h-11');
		expect(wrapper.get('button').classes()).not.toContain('h-9');
	});
});

describe('UiFormField', () => {
	it('links label, control and error message for assistive tech', () => {
		const wrapper = mount(UiFormField, {
			props: { label: 'Email', error: 'This email is already in use', id: 'email' },
			slots: {
				default: (s: { id: string; describedBy?: string; invalid: boolean }) =>
					h(UiInput, { id: s.id, 'aria-describedby': s.describedBy, invalid: s.invalid }),
			},
		});
		const input = wrapper.get('input');
		expect(wrapper.get('label').attributes('for')).toBe('email');
		expect(input.attributes('id')).toBe('email');
		expect(input.attributes('aria-invalid')).toBe('true');
		const msg = wrapper.get('[role="alert"]');
		expect(input.attributes('aria-describedby')).toBe(msg.attributes('id'));
		expect(msg.text()).toContain('already in use');
	});
});

describe('UiDialog', () => {
	const Host = defineComponent({
		setup() {
			const open = ref(false);
			return () =>
				h('div', [
					h(
						'button',
						{
							id: 'open-btn',
							onClick: () => {
								open.value = true;
							},
						},
						'Open',
					),
					h(
						UiDialog,
						{
							open: open.value,
							'onUpdate:open': (v: boolean) => {
								open.value = v;
							},
							title: 'Create user',
						},
						{ default: () => h('input', { id: 'first' }) },
					),
				]);
		},
	});

	it('opens modally, focuses the first field, locks scroll and closes on Esc', async () => {
		const wrapper = mount(Host, { attachTo: document.body });
		const opener = wrapper.get('#open-btn');
		(opener.element as HTMLButtonElement).focus();
		await opener.trigger('click');
		await flushPromises();

		const dialog = wrapper.get('dialog').element as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
		expect(document.activeElement?.id).toBe('first');
		expect(document.documentElement.style.overflow).toBe('hidden');

		dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
		await flushPromises();
		expect(dialog.open).toBe(false);
		expect(document.documentElement.style.overflow).toBe('');
		expect(document.activeElement?.id).toBe('open-btn');
		wrapper.unmount();
	});

	it('closes when the backdrop (the dialog element itself) is clicked', async () => {
		const wrapper = mount(Host, { attachTo: document.body });
		await wrapper.get('#open-btn').trigger('click');
		await flushPromises();
		const dialog = wrapper.get('dialog');
		await dialog.trigger('click');
		await flushPromises();
		expect((dialog.element as HTMLDialogElement).open).toBe(false);
		wrapper.unmount();
	});
});

describe('useConfirm + UiConfirmHost', () => {
	it('resolves true on confirm and false on cancel', async () => {
		const wrapper = mount(UiConfirmHost, { attachTo: document.body });
		const confirm = useConfirm();

		const yes = confirm({
			title: 'Delete 2 issues?',
			confirmLabel: 'Delete 2 issues',
			tone: 'danger',
		});
		await flushPromises();
		const confirmBtn = wrapper.get('[data-testid="confirm-dialog-confirm"]');
		expect(confirmBtn.text()).toBe('Delete 2 issues');
		expect(confirmBtn.classes()).toContain('text-level-error');
		await confirmBtn.trigger('click');
		await expect(yes).resolves.toBe(true);

		const no = confirm({ title: 'Revoke token?' });
		await flushPromises();
		await wrapper.get('[data-testid="confirm-dialog-cancel"]').trigger('click');
		await expect(no).resolves.toBe(false);
		wrapper.unmount();
	});

	it('requires typing the name for high-impact actions', async () => {
		const wrapper = mount(UiConfirmHost, { attachTo: document.body });
		const result = useConfirm()({
			title: 'Delete project?',
			requireText: 'web-frontend',
			tone: 'danger',
		});
		await flushPromises();
		const btn = wrapper.get('[data-testid="confirm-dialog-confirm"]');
		expect(btn.attributes('disabled')).toBeDefined();
		await wrapper.get('[data-testid="confirm-dialog-input"]').setValue('web-frontend');
		expect(btn.attributes('disabled')).toBeUndefined();
		await btn.trigger('click');
		await expect(result).resolves.toBe(true);
		wrapper.unmount();
	});
});

describe('useToast + UiToaster', () => {
	it('shows announced toasts and auto-dismisses them', async () => {
		vi.useFakeTimers();
		const wrapper = mount(UiToaster);
		const toast = useToast();
		toast.success('2 issues resolved');
		toast.error('Merge failed');
		await nextTick();
		const items = wrapper.findAll('[data-testid="toast"]');
		expect(items).toHaveLength(2);
		expect(items[0].attributes('role')).toBe('status');
		expect(items[1].attributes('role')).toBe('alert');
		expect(wrapper.get('section').attributes('aria-live')).toBe('polite');

		vi.advanceTimersByTime(4100);
		await nextTick();
		expect(wrapper.findAll('[data-testid="toast"]').map((t) => t.text())).toEqual([
			expect.stringContaining('Merge failed'),
		]);
		wrapper.unmount();
	});

	it('runs the toast action and closes it', async () => {
		const wrapper = mount(UiToaster);
		const undo = vi.fn();
		useToast().success('Issue snoozed', { action: { label: 'Undo', onClick: undo } });
		await nextTick();
		await wrapper.get('[data-testid="toast"] button').trigger('click');
		expect(undo).toHaveBeenCalledOnce();
		await nextTick();
		expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
		wrapper.unmount();
	});
});

describe('UiCopyField', () => {
	it('copies, flips to "Copied" and raises a toast', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const wrapper = mount(UiCopyField, { props: { value: 'https://k@host/1', label: 'DSN' } });
		await wrapper.get('button').trigger('click');
		await flushPromises();
		expect(writeText).toHaveBeenCalledWith('https://k@host/1');
		expect(wrapper.get('button').text()).toContain('Copied');
		expect(useToast().toasts.at(-1)?.message).toBe('DSN copied to clipboard');
	});
});

describe('UiMenu', () => {
	it('opens from the trigger, moves with arrows and selects with Enter', async () => {
		const onSelect = vi.fn();
		const wrapper = mount(UiMenu, {
			attachTo: document.body,
			props: {
				label: 'Snooze',
				items: [
					{ value: 30, label: '30 minutes' },
					{ value: 120, label: '2 hours' },
				],
				onSelect,
			},
			slots: {
				trigger: (s: { props: Record<string, unknown> }) =>
					h('button', { id: 'trigger', ...s.props }, 'Snooze'),
			},
		});
		const trigger = wrapper.get('#trigger');
		expect(trigger.attributes('aria-haspopup')).toBe('menu');
		await trigger.trigger('click');
		await flushPromises();
		expect(trigger.attributes('aria-expanded')).toBe('true');
		const menu = document.querySelector('[role="menu"]') as HTMLElement;
		expect(menu).toBeTruthy();
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await flushPromises();
		expect(onSelect).toHaveBeenCalledWith(120);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		wrapper.unmount();
	});
});

describe('UiTabs', () => {
	it('moves selection with the arrow keys (roving tabindex)', async () => {
		const selected = ref('unresolved');
		const Host = defineComponent({
			setup: () => () =>
				h(UiTabs, {
					label: 'Status',
					modelValue: selected.value,
					'onUpdate:modelValue': (v: string | number) => {
						selected.value = String(v);
					},
					items: [
						{ value: 'unresolved', label: 'Unresolved', count: 128 },
						{ value: 'resolved', label: 'Resolved' },
					],
				}),
		});
		const wrapper = mount(Host);
		const tabs = wrapper.findAll('[role="tab"]');
		expect(tabs[0].attributes('aria-selected')).toBe('true');
		expect(tabs[1].attributes('tabindex')).toBe('-1');
		await tabs[0].trigger('keydown', { key: 'ArrowRight' });
		expect(selected.value).toBe('resolved');
		expect(wrapper.findAll('[role="tab"]')[1].attributes('aria-selected')).toBe('true');
	});
});
