import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppKaneoIntegration, {
	type KaneoIntegration,
} from '../components/app/AppKaneoIntegration.vue';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { seedAuth } from './helpers';
import { MockApiError, mockApi, onDelete, onGet, onPost, onPut, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const URL = '/api/projects/web-frontend/integrations/kaneo';

const COLUMNS = [
	{ id: 'c1', name: 'Backlog', slug: 'backlog', position: 0, isFinal: false },
	{ id: 'c2', name: 'To Do', slug: 'to-do', position: 1, isFinal: false },
	{ id: 'c4', name: 'Done', slug: 'done', position: 3, isFinal: true },
];

const SAVED: KaneoIntegration = {
	id: 'int-1',
	enabled: true,
	baseUrl: 'https://kaneo.example.com',
	workspaceId: 'ws1',
	kaneoProjectId: 'kp1',
	kaneoProjectName: 'Sentinel',
	kaneoProjectSlug: 'SNT',
	createColumn: 'to-do',
	doneColumn: 'done',
	reopenColumn: 'to-do',
	autoCreate: false,
	minLevel: 'error',
	environments: [],
	apiKey: 'kane…6789',
	accessClientId: null,
	hasAccessToken: false,
	credentialsReadable: true,
	lastError: null,
	lastErrorAt: null,
};

function discoverHandler(body?: unknown) {
	const request = body as { workspaceId?: string; kaneoProjectId?: string };
	return {
		workspaces: [{ id: 'ws1', name: 'Personal', slug: 'personal' }],
		projects: request.workspaceId
			? [{ id: 'kp1', name: 'Sentinel', slug: 'SNT', workspaceId: 'ws1' }]
			: undefined,
		columns: request.kaneoProjectId ? COLUMNS : undefined,
	};
}

async function mountCard() {
	const { pinia } = seedAuth({});
	const wrapper = mount(AppKaneoIntegration, {
		props: { slug: 'web-frontend' },
		attachTo: document.body,
		global: { plugins: [pinia] },
	});
	await flushPromises();
	return wrapper;
}

beforeEach(() => resetMocks());

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('Kaneo integration card', () => {
	it('connects: loads projects with the typed key, picks default columns, saves', async () => {
		onGet(URL, () => ({ configured: true, integration: null }));
		onPost(`${URL}/discover`, discoverHandler);
		onPut(URL, () => ({ integration: SAVED }));
		const wrapper = await mountCard();

		expect(wrapper.get('#kaneo').text()).toContain('Not connected');
		const connect = wrapper.get('button[type="submit"]');
		expect(connect.text()).toBe('Connect');
		expect(connect.attributes('disabled')).toBeDefined();

		const inputs = wrapper.findAll('input');
		await inputs[0].setValue('https://kaneo.example.com');
		await inputs[1].setValue('kaneo-api-key-123456789');
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Load projects')!
			.trigger('click');
		await flushPromises();

		// One workspace is picked automatically and its projects load
		const discoverCalls = mockApi.calls.filter((c) => c.url === `${URL}/discover`);
		expect(discoverCalls[0].body).toMatchObject({
			baseUrl: 'https://kaneo.example.com',
			apiKey: 'kaneo-api-key-123456789',
		});
		expect(discoverCalls[1].body).toMatchObject({ workspaceId: 'ws1' });

		const projectSelect = wrapper.findAll('select')[0];
		await projectSelect.setValue('kp1');
		await projectSelect.trigger('change');
		await flushPromises();
		const selects = wrapper.findAll('select');
		expect((selects[1].element as HTMLSelectElement).value).toBe('to-do');
		expect((selects[2].element as HTMLSelectElement).value).toBe('done');
		expect((selects[3].element as HTMLSelectElement).value).toBe('to-do');

		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'put')?.body).toMatchObject({
			baseUrl: 'https://kaneo.example.com',
			apiKey: 'kaneo-api-key-123456789',
			kaneoProjectId: 'kp1',
			createColumn: 'to-do',
			doneColumn: 'done',
			reopenColumn: 'to-do',
			autoCreate: false,
			environments: [],
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo connected');
		// The key never stays in the form after saving
		expect((wrapper.findAll('input')[1].element as HTMLInputElement).value).toBe('');
		wrapper.unmount();
	});

	it('shows a saved connection with the key masked and keeps it on save', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED }));
		onPost(`${URL}/discover`, discoverHandler);
		onPut(URL, () => ({ integration: { ...SAVED, autoCreate: true } }));
		const wrapper = await mountCard();

		expect(wrapper.get('#kaneo').text()).toContain('Connected');
		expect(wrapper.text()).toContain('Saved (kane…6789)');
		expect((wrapper.findAll('input')[1].element as HTMLInputElement).value).toBe('');
		// Columns of the saved project load on their own (stored credentials)
		expect(mockApi.calls.find((c) => c.url === `${URL}/discover`)?.body).toMatchObject({
			kaneoProjectId: 'kp1',
		});
		expect(mockApi.calls.find((c) => c.url === `${URL}/discover`)?.body).not.toHaveProperty(
			'apiKey',
		);

		await wrapper.get('button[role="switch"]').trigger('click');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		const body = mockApi.calls.find((c) => c.method === 'put')?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty('apiKey');
		expect(body.autoCreate).toBe(true);
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo settings saved');
		wrapper.unmount();
	});

	it('shows the last delivery failure', async () => {
		onGet(URL, () => ({
			configured: true,
			integration: { ...SAVED, lastError: 'Kaneo answered 401: Unauthorized' },
		}));
		onPost(`${URL}/discover`, discoverHandler);
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('Last delivery failed: Kaneo answered 401: Unauthorized');
		wrapper.unmount();
	});

	it('tests and asks before disconnecting', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED }));
		onPost(`${URL}/discover`, discoverHandler);
		onPost(`${URL}/test`, () => ({
			ok: true,
			project: { id: 'kp1', name: 'Sentinel', slug: 'SNT' },
		}));
		onDelete(URL, () => ({ deleted: true }));
		const wrapper = await mountCard();

		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Test connection')!
			.trigger('click');
		await flushPromises();
		expect(useToast().toasts.at(-1)?.message).toContain('Sentinel is reachable');

		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Disconnect')!
			.trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', confirmLabel: 'Disconnect' });
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete' && c.url === URL)).toBe(true);
		expect(wrapper.get('#kaneo').text()).toContain('Not connected');
		wrapper.unmount();
	});

	it('explains when the instance has no INTEGRATIONS_KEY', async () => {
		onGet(URL, () => ({ configured: false, integration: null }));
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('INTEGRATIONS_KEY');
		expect(wrapper.find('form').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows Kaneo errors from discovery inline', async () => {
		onGet(URL, () => ({ configured: true, integration: null }));
		onPost(
			`${URL}/discover`,
			() => new MockApiError('Kaneo answered 401: Unauthorized', 502, 'kaneo_failed'),
		);
		const wrapper = await mountCard();
		await wrapper.findAll('input')[0].setValue('https://kaneo.example.com');
		await wrapper.findAll('input')[1].setValue('wrong');
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Load projects')!
			.trigger('click');
		await flushPromises();
		expect(wrapper.get('[role="alert"]').text()).toContain('Kaneo answered 401');
		wrapper.unmount();
	});
});
