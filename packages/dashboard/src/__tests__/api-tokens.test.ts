import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import ApiTokens from '../views/ApiTokens.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { mockApi, onDelete, onGet, onPost } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const token = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	userId: 'user-1',
	name: 'Claude Code',
	tokenPrefix: 'wst_3f9a',
	lastUsedAt: null,
	expiresAt: null,
	createdAt: '2026-11-20T12:00:00Z',
	...extra,
});

async function mountTokens() {
	const { pinia } = seedAuth({});
	const router = testRouter();
	await atRoute(router, '/settings/tokens');
	const wrapper = mount(ApiTokens, {
		attachTo: document.body,
		global: { plugins: [pinia, router] },
	});
	await flushPromises();
	return wrapper;
}

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('API tokens', () => {
	it('lists tokens with usage, expiry and a summary', async () => {
		onGet('/api/auth/tokens', () => ({
			tokens: [
				token('t1'),
				token('t2', {
					name: 'Old script',
					tokenPrefix: 'wst_0d47',
					expiresAt: '2026-01-01T12:00:00Z',
				}),
			],
		}));
		const wrapper = await mountTokens();
		const rows = wrapper.findAll('[data-testid="token-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].text()).toContain('wst_3f9a…');
		expect(rows[0].text()).toContain('Never used · Never expires');
		expect(rows[1].text()).toContain('Expired Jan 1, 2026');
		expect(wrapper.text()).toContain('1 active · 1 expired');
		wrapper.unmount();
	});

	it('creates a token and shows it once in a dialog only Done closes', async () => {
		onGet('/api/auth/tokens', () => ({ tokens: [] }));
		onPost('/api/auth/tokens', () => ({
			token: token('t9', { name: 'CI' }),
			rawToken: 'wst_secret123',
		}));
		const wrapper = await mountTokens();
		expect(wrapper.get('[data-testid="tokens-empty"]').text()).toContain('No API tokens yet');

		await wrapper.get('[data-testid="create-token"]').trigger('click');
		await flushPromises();
		await wrapper.get('[data-testid="token-name"]').setValue('CI');
		await wrapper.get('[data-testid="token-dialog"] form').trigger('submit');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'post')?.body).toEqual({ name: 'CI' });

		const created = wrapper.get('[data-testid="token-created"]');
		expect((created.element as HTMLDialogElement).open).toBe(true);
		expect(created.get('output[aria-label="API token"]').text()).toBe('wst_secret123');
		// Not dismissible: no close button, Esc is ignored
		expect(created.find('button[aria-label="Close"]').exists()).toBe(false);
		created.element.dispatchEvent(new Event('cancel', { cancelable: true }));
		await flushPromises();
		expect((created.element as HTMLDialogElement).open).toBe(true);

		await wrapper.get('[data-testid="token-created-done"]').trigger('click');
		await flushPromises();
		expect(wrapper.find('output[aria-label="API token"]').exists()).toBe(false);
		expect(wrapper.findAll('[data-testid="token-row"]')).toHaveLength(1);
		wrapper.unmount();
	});

	it('sends the expiry date when given', async () => {
		onGet('/api/auth/tokens', () => ({ tokens: [] }));
		onPost('/api/auth/tokens', () => ({ token: token('t9'), rawToken: 'wst_x' }));
		const wrapper = await mountTokens();
		await wrapper.get('[data-testid="create-token"]').trigger('click');
		await wrapper.get('[data-testid="token-name"]').setValue('CI');
		await wrapper.get('[data-testid="token-expiry"]').setValue('2027-01-31');
		await wrapper.get('[data-testid="token-dialog"] form').trigger('submit');
		await flushPromises();
		const body = mockApi.calls.find((c) => c.method === 'post')?.body as { expiresAt?: string };
		expect(body.expiresAt).toBe(new Date('2027-01-31').toISOString());
		wrapper.unmount();
	});

	it('asks before revoking a token', async () => {
		onGet('/api/auth/tokens', () => ({ tokens: [token('t1')] }));
		onDelete('/api/auth/tokens/t1', () => ({ success: true }));
		const wrapper = await mountTokens();
		await wrapper.get('button[aria-label="Revoke token Claude Code"]').trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', confirmLabel: 'Revoke token' });
		settleConfirm(true);
		await flushPromises();
		expect(
			mockApi.calls.some((c) => c.method === 'delete' && c.url === '/api/auth/tokens/t1'),
		).toBe(true);
		expect(wrapper.findAll('[data-testid="token-row"]')).toHaveLength(0);
		expect(useToast().toasts.at(-1)?.message).toBe('Token "Claude Code" revoked');
		wrapper.unmount();
	});
});
