import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppKaneoIntegration from '../components/app/AppKaneoIntegration.vue';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import type { KaneoIntegration } from '../lib/integrations';
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
	status: 'connected',
	baseUrl: 'https://kaneo.example.com',
	workspaceId: 'ws1',
	workspaceName: 'Personal',
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
	credentialsReadable: true,
	lastError: null,
	lastErrorAt: null,
	webhookStatus: 'installed',
	webhookError: null,
};
const PENDING: KaneoIntegration = {
	...SAVED,
	status: 'pending',
	kaneoProjectId: '',
	kaneoProjectName: '',
	kaneoProjectSlug: '',
	createColumn: '',
	doneColumn: '',
	reopenColumn: '',
	webhookStatus: null,
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

type Wrapper = Awaited<ReturnType<typeof mountCard>>;
const button = (wrapper: Wrapper, text: string) =>
	wrapper.findAll('button').find((b) => b.text() === text)!;
const stepState = (wrapper: Wrapper, step: string) =>
	wrapper.get(`[data-testid="kaneo-${step}"]`).attributes('data-state');
const header = (wrapper: Wrapper) => wrapper.get('[data-testid="connection-header"]');

beforeEach(() => resetMocks());

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('Kaneo integration steps', () => {
	it('walks through the steps: key saved as pending, projects load, default columns, connect', async () => {
		onGet(URL, () => ({ configured: true, integration: null }));
		onPost(`${URL}/discover`, discoverHandler);
		onPut(URL, (body) =>
			(body as Record<string, unknown>).kaneoProjectId
				? { integration: SAVED }
				: { integration: PENDING },
		);
		const wrapper = await mountCard();

		expect(header(wrapper).attributes('data-state')).toBe('off');
		expect(stepState(wrapper, 'step-connect')).toBe('current');
		expect(stepState(wrapper, 'step-project')).toBe('locked');
		expect(stepState(wrapper, 'webhook')).toBe('locked');

		// The API keys link appears once the URL is typed.
		expect(wrapper.find('a[data-testid="kaneo-api-keys-link"]').exists()).toBe(false);
		await wrapper.get('[data-testid="kaneo-url"]').setValue('https://kaneo.example.com/api');
		const keysLink = wrapper.get('a[data-testid="kaneo-api-keys-link"]');
		expect(keysLink.attributes('href')).toBe(
			'https://kaneo.example.com/dashboard/settings/account/developer',
		);
		expect(keysLink.attributes('target')).toBe('_blank');

		await wrapper.get('[data-testid="kaneo-key"]').setValue('kaneo-typed-key');
		await button(wrapper, 'Verify & save').trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'put')?.body).toEqual({
			baseUrl: 'https://kaneo.example.com/api',
			apiKey: 'kaneo-typed-key',
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo key verified · workspace Personal');
		expect(header(wrapper).attributes('data-state')).toBe('pending');
		expect(stepState(wrapper, 'step-connect')).toBe('done');
		// Projects load with the saved key: never the typed key again.
		const discovers = mockApi.calls.filter((c) => c.url === `${URL}/discover`);
		expect(discovers.every((c) => !(c.body as Record<string, unknown>).apiKey)).toBe(true);
		expect(discovers.at(-1)?.body).toEqual({ workspaceId: 'ws1' });

		await wrapper.get('[data-testid="kaneo-project"]').setValue('kp1');
		await button(wrapper, 'Continue').trigger('click');
		await flushPromises();
		expect(stepState(wrapper, 'step-project')).toBe('done');
		expect(stepState(wrapper, 'step-columns')).toBe('current');
		const selects = wrapper.get('[data-testid="kaneo-step-columns"]').findAll('select');
		expect((selects[0].element as HTMLSelectElement).value).toBe('to-do');
		expect((selects[1].element as HTMLSelectElement).value).toBe('done');
		expect((selects[2].element as HTMLSelectElement).value).toBe('to-do');

		await wrapper.get('button[role="switch"]').trigger('click');
		await button(wrapper, 'Save and connect').trigger('click');
		await flushPromises();
		expect(mockApi.calls.filter((c) => c.method === 'put').at(-1)?.body).toEqual({
			kaneoProjectId: 'kp1',
			createColumn: 'to-do',
			doneColumn: 'done',
			reopenColumn: 'to-do',
			autoCreate: true,
			minLevel: 'error',
			environments: [],
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo connected');
		expect(header(wrapper).attributes('data-state')).toBe('connected');
		expect(stepState(wrapper, 'webhook')).toBe('done');
		expect(wrapper.get('[data-testid="kaneo-webhook"]').text()).toContain('resolves its issue');
		wrapper.unmount();
	});

	it('resumes a pending setup: the key is kept and projects load by themselves', async () => {
		onGet(URL, () => ({ configured: true, integration: PENDING }));
		onPost(`${URL}/discover`, discoverHandler);
		const wrapper = await mountCard();
		expect(stepState(wrapper, 'step-connect')).toBe('done');
		expect(wrapper.get('[data-testid="kaneo-step-connect"]').text()).toContain('key kane…6789');
		expect(stepState(wrapper, 'step-project')).toBe('current');
		expect(wrapper.findAll('[data-testid="kaneo-project"] option').map((o) => o.text())).toContain(
			'Sentinel (SNT)',
		);
		wrapper.unmount();
	});

	it('shows a saved connection and keeps the key when settings change', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED }));
		onPost(`${URL}/discover`, discoverHandler);
		onPut(URL, () => ({ integration: { ...SAVED, minLevel: 'warning', autoCreate: true } }));
		const wrapper = await mountCard();

		expect(header(wrapper).text()).toContain('Connected to Sentinel (SNT)');
		// Columns load with the stored key (never sent from the browser).
		expect(mockApi.calls.find((c) => c.url === `${URL}/discover`)?.body).toEqual({
			kaneoProjectId: 'kp1',
		});
		const changes = wrapper.findAll('button').filter((b) => b.text() === 'Change');
		await changes[2].trigger('click');
		await wrapper.get('button[role="switch"]').trigger('click');
		await flushPromises();
		await wrapper
			.get('[data-testid="kaneo-step-columns"]')
			.findAll('select')[3]
			.setValue('warning');
		await button(wrapper, 'Save').trigger('click');
		await flushPromises();
		const body = mockApi.calls.find((c) => c.method === 'put')?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty('apiKey');
		expect(body).toMatchObject({ kaneoProjectId: 'kp1', autoCreate: true, minLevel: 'warning' });
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo settings saved');
		wrapper.unmount();
	});

	it('explains a webhook already in use, links to Kaneo and retries', async () => {
		onGet(URL, () => ({
			configured: true,
			integration: {
				...SAVED,
				webhookStatus: 'in_use',
				webhookError: 'This Kaneo project already has a webhook',
			},
		}));
		onPost(`${URL}/discover`, discoverHandler);
		onPut(URL, () => ({ integration: SAVED }));
		const wrapper = await mountCard();

		expect(header(wrapper).attributes('data-state')).toBe('attention');
		expect(header(wrapper).text()).toContain('one-way');
		expect(stepState(wrapper, 'webhook')).toBe('current');
		const step = wrapper.get('[data-testid="kaneo-webhook"]');
		expect(step.text()).toContain('Kaneo allows one webhook per project');
		expect(step.get('[data-testid="kaneo-project-integrations-link"]').attributes('href')).toBe(
			'https://kaneo.example.com/dashboard/settings/projects/kp1/integrations',
		);
		await button(wrapper, 'Try again').trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'put')?.body).toEqual({});
		expect(useToast().toasts.at(-1)?.message).toBe('Two-way sync is on');
		expect(stepState(wrapper, 'webhook')).toBe('done');
		wrapper.unmount();
	});

	it('shows a refused key in the first step', async () => {
		onGet(URL, () => ({ configured: true, integration: null }));
		onPut(URL, () => new MockApiError('Kaneo answered 401: Unauthorized', 502, 'kaneo_failed'));
		const wrapper = await mountCard();
		await wrapper.get('[data-testid="kaneo-url"]').setValue('https://kaneo.example.com');
		await wrapper.get('[data-testid="kaneo-key"]').setValue('wrong');
		await button(wrapper, 'Verify & save').trigger('click');
		await flushPromises();
		expect(wrapper.get('[data-testid="kaneo-step-connect"] [role="alert"]').text()).toContain(
			'401',
		);
		expect(stepState(wrapper, 'step-connect')).toBe('current');
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

		await button(wrapper, 'Send test').trigger('click');
		await flushPromises();
		expect(useToast().toasts.at(-1)?.message).toContain('Sentinel is reachable');

		await button(wrapper, 'Disconnect').trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', confirmLabel: 'Disconnect' });
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete' && c.url === URL)).toBe(true);
		expect(header(wrapper).text()).toContain('Not connected');
		wrapper.unmount();
	});

	it('explains when the instance has no INTEGRATIONS_KEY', async () => {
		onGet(URL, () => ({ configured: false, integration: null }));
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('INTEGRATIONS_KEY');
		expect(wrapper.find('[data-testid="kaneo-step-connect"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
