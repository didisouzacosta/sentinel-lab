import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppSlackIntegration, {
	type SlackIntegration,
} from '../components/app/AppSlackIntegration.vue';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { seedAuth } from './helpers';
import { MockApiError, mockApi, onDelete, onGet, onPost, onPut, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const URL = '/api/projects/web-frontend/integrations/slack';
const MANIFEST = {
	display_information: { name: 'Sentinel' },
	oauth_config: { scopes: { bot: ['chat:write', 'channels:read'] } },
};
const CHANNELS = [
	{ id: 'C0ERRORS', name: 'errors', isPrivate: false, isMember: false },
	{ id: 'G0SECRET', name: 'secret', isPrivate: true, isMember: true },
];

const SAVED: SlackIntegration = {
	id: 'int-slack',
	enabled: true,
	teamId: 'T0ACME',
	teamName: 'Acme',
	channelId: 'C0ERRORS',
	channelName: 'errors',
	channelPrivate: false,
	minLevel: 'error',
	environments: [],
	notifyRegression: true,
	notifyResolved: true,
	botToken: 'xoxb…oken',
	credentialsReadable: true,
	lastError: null,
	lastErrorAt: null,
};

async function mountCard() {
	const { pinia } = seedAuth({});
	const wrapper = mount(AppSlackIntegration, {
		props: { slug: 'web-frontend' },
		attachTo: document.body,
		global: { plugins: [pinia] },
	});
	await flushPromises();
	return wrapper;
}

const button = (wrapper: Awaited<ReturnType<typeof mountCard>>, text: string) =>
	wrapper.findAll('button').find((b) => b.text() === text)!;

beforeEach(() => resetMocks());

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('Slack integration card', () => {
	it('walks through setup: app from the manifest, token, channel, connect', async () => {
		onGet(URL, () => ({ configured: true, integration: null, manifest: MANIFEST }));
		onPost(`${URL}/discover`, () => ({
			team: { id: 'T0ACME', name: 'Acme' },
			channels: CHANNELS,
			truncated: false,
		}));
		onPut(URL, () => ({ integration: SAVED }));
		const wrapper = await mountCard();

		expect(wrapper.get('#slack').text()).toContain('Not connected');
		const create = wrapper.get('[data-testid="slack-create-app"]');
		const href = create.attributes('href')!;
		expect(href.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
		expect(JSON.parse(decodeURIComponent(href.split('manifest_json=')[1]))).toEqual(MANIFEST);
		expect(create.attributes('rel')).toContain('noopener');
		expect(wrapper.text()).toContain('chat:write');

		const connect = wrapper.get('button[type="submit"]');
		expect(connect.attributes('disabled')).toBeDefined();
		await wrapper.get('input').setValue('xoxb-typed-token');
		await button(wrapper, 'Load channels').trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.url === `${URL}/discover`)?.body).toEqual({
			botToken: 'xoxb-typed-token',
		});
		expect(wrapper.text()).toContain('Workspace: Acme');

		await wrapper.findAll('select')[0].setValue('C0ERRORS');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'put')?.body).toEqual({
			botToken: 'xoxb-typed-token',
			channelId: 'C0ERRORS',
			minLevel: 'error',
			environments: [],
			notifyRegression: true,
			notifyResolved: true,
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Slack connected to #errors');
		expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
		expect(wrapper.get('#slack').text()).toContain('#errors');
		expect(wrapper.find('[data-testid="slack-setup"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows a saved connection with the token masked and keeps it on save', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED, manifest: MANIFEST }));
		onPut(URL, () => ({ integration: { ...SAVED, notifyResolved: false } }));
		const wrapper = await mountCard();

		expect(wrapper.text()).toContain('Saved (xoxb…oken)');
		expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('C0ERRORS');
		await wrapper.findAll('button[role="switch"]')[1].trigger('click');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		const body = mockApi.calls.find((c) => c.method === 'put')?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty('botToken');
		expect(body.notifyResolved).toBe(false);
		expect(useToast().toasts.at(-1)?.message).toBe('Slack settings saved');
		wrapper.unmount();
	});

	it('shows the last delivery failure', async () => {
		onGet(URL, () => ({
			configured: true,
			integration: { ...SAVED, lastError: 'The bot is not in that channel' },
			manifest: MANIFEST,
		}));
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('Last delivery failed: The bot is not in that channel');
		wrapper.unmount();
	});

	it('sends a test message and asks before disconnecting', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED, manifest: MANIFEST }));
		onPost(`${URL}/test`, () => ({ ok: true, channel: { id: 'C0ERRORS', name: 'errors' } }));
		onDelete(URL, () => ({ deleted: true }));
		const wrapper = await mountCard();

		await button(wrapper, 'Send test message').trigger('click');
		await flushPromises();
		expect(useToast().toasts.at(-1)?.message).toBe('Test message posted to #errors');

		await button(wrapper, 'Disconnect').trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', confirmLabel: 'Disconnect' });
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete' && c.url === URL)).toBe(true);
		expect(wrapper.get('#slack').text()).toContain('Not connected');
		wrapper.unmount();
	});

	it('explains when the instance has no INTEGRATIONS_KEY', async () => {
		onGet(URL, () => ({ configured: false, integration: null, manifest: MANIFEST }));
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('INTEGRATIONS_KEY');
		expect(wrapper.find('form').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows Slack errors from discovery inline', async () => {
		onGet(URL, () => ({ configured: true, integration: null, manifest: MANIFEST }));
		onPost(
			`${URL}/discover`,
			() => new MockApiError('Slack refused the token (invalid_auth)', 502, 'slack_failed'),
		);
		const wrapper = await mountCard();
		await wrapper.get('input').setValue('xoxb-wrong');
		await button(wrapper, 'Load channels').trigger('click');
		await flushPromises();
		expect(wrapper.get('[role="alert"]').text()).toContain('invalid_auth');
		wrapper.unmount();
	});
});
