import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppSlackIntegration from '../components/app/AppSlackIntegration.vue';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import type { SlackIntegration } from '../lib/integrations';
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
	status: 'connected',
	appId: 'A08K2TX4R1Q',
	teamId: 'T0ACME',
	teamName: 'Acme',
	botUserId: 'U0BOT',
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
const PENDING: SlackIntegration = {
	...SAVED,
	status: 'pending',
	channelId: '',
	channelName: '',
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

type Wrapper = Awaited<ReturnType<typeof mountCard>>;
const button = (wrapper: Wrapper, text: string) =>
	wrapper.findAll('button').find((b) => b.text() === text)!;
const stepState = (wrapper: Wrapper, step: string) =>
	wrapper.get(`[data-testid="slack-step-${step}"]`).attributes('data-state');

beforeEach(() => resetMocks());

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('Slack integration steps', () => {
	it('walks through the steps: app page, token saved as pending, channels load, connect', async () => {
		onGet(URL, () => ({ configured: true, integration: null, manifest: MANIFEST }));
		onPut(URL, (body) =>
			(body as Record<string, unknown>).channelId
				? { integration: SAVED }
				: { integration: PENDING },
		);
		onPost(`${URL}/discover`, () => ({
			team: { id: 'T0ACME', name: 'Acme' },
			channels: CHANNELS,
			truncated: false,
		}));
		const wrapper = await mountCard();

		expect(wrapper.get('[data-testid="connection-header"]').attributes('data-state')).toBe('off');
		expect([
			stepState(wrapper, 'app'),
			stepState(wrapper, 'token'),
			stepState(wrapper, 'channel'),
		]).toEqual(['current', 'locked', 'locked']);
		expect(wrapper.text()).toContain('Complete step 1 first');

		// Step 1: the manifest link, then the app page (its App ID builds the next links).
		const create = wrapper.get('[data-testid="slack-create-app"]');
		const href = create.attributes('href')!;
		expect(href.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
		expect(JSON.parse(decodeURIComponent(href.split('manifest_json=')[1]))).toEqual(MANIFEST);
		expect(create.attributes('rel')).toContain('noopener');
		expect(create.attributes('target')).toBe('_blank');
		await wrapper
			.get('[data-testid="slack-app-page"]')
			.setValue('https://api.slack.com/apps/A08K2TX4R1Q');
		await button(wrapper, 'Continue').trigger('click');
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'put')).toBe(false);
		expect(stepState(wrapper, 'app')).toBe('done');

		// Step 2: links straight to Install and OAuth & Permissions of that app.
		expect(wrapper.get('[data-testid="slack-install-link"]').attributes('href')).toBe(
			'https://api.slack.com/apps/A08K2TX4R1Q/install-on-team',
		);
		expect(wrapper.get('[data-testid="slack-oauth-link"]').attributes('href')).toBe(
			'https://api.slack.com/apps/A08K2TX4R1Q/oauth',
		);
		await wrapper.get('[data-testid="slack-token"]').setValue('xoxb-typed-token');
		await button(wrapper, 'Verify & save').trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'put')?.body).toEqual({
			botToken: 'xoxb-typed-token',
			appId: 'A08K2TX4R1Q',
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Token verified · workspace Acme');
		expect(wrapper.get('[data-testid="connection-header"]').attributes('data-state')).toBe(
			'pending',
		);
		expect(stepState(wrapper, 'token')).toBe('done');
		// Channels loaded by themselves with the saved token.
		expect(mockApi.calls.find((c) => c.url === `${URL}/discover`)?.body).toEqual({});

		// Step 3
		await wrapper.get('[data-testid="slack-channel"]').setValue('C0ERRORS');
		await button(wrapper, 'Save and connect').trigger('click');
		await flushPromises();
		expect(mockApi.calls.filter((c) => c.method === 'put').at(-1)?.body).toEqual({
			channelId: 'C0ERRORS',
			minLevel: 'error',
			environments: [],
			notifyRegression: true,
			notifyResolved: true,
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Slack connected to #errors');
		expect(wrapper.get('[data-testid="connection-header"]').attributes('data-state')).toBe(
			'connected',
		);
		expect(wrapper.get('[data-testid="connection-header"]').text()).toContain(
			'Connected to #errors',
		);
		expect(stepState(wrapper, 'channel')).toBe('done');
		wrapper.unmount();
	});

	it('refuses an app page that is not one, and can skip it', async () => {
		onGet(URL, () => ({ configured: true, integration: null, manifest: MANIFEST }));
		const wrapper = await mountCard();
		await wrapper.get('[data-testid="slack-app-page"]').setValue('https://example.com/nope');
		await button(wrapper, 'Continue').trigger('click');
		await flushPromises();
		expect(wrapper.get('[role="alert"]').text()).toContain('does not look like a Slack app page');

		await button(wrapper, 'I already have a token').trigger('click');
		await flushPromises();
		expect(stepState(wrapper, 'token')).toBe('current');
		expect(wrapper.get('[data-testid="slack-oauth-link"]').attributes('href')).toBe(
			'https://api.slack.com/apps',
		);
		wrapper.unmount();
	});

	it('resumes a pending setup: token kept, channels load by themselves', async () => {
		onGet(URL, () => ({ configured: true, integration: PENDING, manifest: MANIFEST }));
		onPost(`${URL}/discover`, () => ({
			team: { name: 'Acme' },
			channels: CHANNELS,
			truncated: false,
		}));
		const wrapper = await mountCard();
		expect(stepState(wrapper, 'token')).toBe('done');
		expect(wrapper.get('[data-testid="slack-step-token"]').text()).toContain('token xoxb…oken');
		expect(stepState(wrapper, 'channel')).toBe('current');
		expect(wrapper.findAll('[data-testid="slack-channel"] option').map((o) => o.text())).toContain(
			'#errors',
		);
		wrapper.unmount();
	});

	it('shows a saved connection, reopens a step with Change and keeps the token on save', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED, manifest: MANIFEST }));
		onPost(`${URL}/discover`, () => ({
			team: { name: 'Acme' },
			channels: CHANNELS,
			truncated: false,
		}));
		onPut(URL, () => ({ integration: { ...SAVED, notifyResolved: false } }));
		const wrapper = await mountCard();

		expect([
			stepState(wrapper, 'app'),
			stepState(wrapper, 'token'),
			stepState(wrapper, 'channel'),
		]).toEqual(['done', 'done', 'done']);
		expect(wrapper.get('[data-testid="slack-step-app"]').text()).toContain('App A08K2TX4R1Q');
		const changeButtons = wrapper.findAll('button').filter((b) => b.text() === 'Change');
		await changeButtons[2].trigger('click');
		await flushPromises();
		expect(stepState(wrapper, 'channel')).toBe('current');
		expect((wrapper.get('[data-testid="slack-channel"]').element as HTMLSelectElement).value).toBe(
			'C0ERRORS',
		);
		await wrapper.findAll('button[role="switch"]')[1].trigger('click');
		await button(wrapper, 'Save').trigger('click');
		await flushPromises();
		const body = mockApi.calls.find((c) => c.method === 'put')?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty('botToken');
		expect(body.notifyResolved).toBe(false);
		expect(useToast().toasts.at(-1)?.message).toBe('Slack settings saved');
		wrapper.unmount();
	});

	it('shows the last delivery failure as needing attention', async () => {
		onGet(URL, () => ({
			configured: true,
			integration: { ...SAVED, lastError: 'The bot is not in that channel' },
			manifest: MANIFEST,
		}));
		const wrapper = await mountCard();
		expect(wrapper.get('[data-testid="connection-header"]').attributes('data-state')).toBe(
			'attention',
		);
		expect(wrapper.text()).toContain('Last delivery failed: The bot is not in that channel');
		wrapper.unmount();
	});

	it('sends a test message and asks before disconnecting', async () => {
		onGet(URL, () => ({ configured: true, integration: SAVED, manifest: MANIFEST }));
		onPost(`${URL}/test`, () => ({ ok: true, channel: { id: 'C0ERRORS', name: 'errors' } }));
		onDelete(URL, () => ({ deleted: true }));
		const wrapper = await mountCard();

		await button(wrapper, 'Send test').trigger('click');
		await flushPromises();
		expect(useToast().toasts.at(-1)?.message).toBe('Test message posted to #errors');

		await button(wrapper, 'Disconnect').trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', confirmLabel: 'Disconnect' });
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete' && c.url === URL)).toBe(true);
		expect(wrapper.get('[data-testid="connection-header"]').text()).toContain('Not connected');
		expect(stepState(wrapper, 'app')).toBe('current');
		wrapper.unmount();
	});

	it('explains when the instance has no INTEGRATIONS_KEY', async () => {
		onGet(URL, () => ({ configured: false, integration: null, manifest: MANIFEST }));
		const wrapper = await mountCard();
		expect(wrapper.text()).toContain('INTEGRATIONS_KEY');
		expect(wrapper.find('[data-testid="slack-step-app"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('shows a refused token in the token step', async () => {
		onGet(URL, () => ({ configured: true, integration: null, manifest: MANIFEST }));
		onPut(
			URL,
			() => new MockApiError('Slack refused the token (invalid_auth)', 400, 'slack_failed'),
		);
		const wrapper = await mountCard();
		await button(wrapper, 'I already have a token').trigger('click');
		await wrapper.get('[data-testid="slack-token"]').setValue('xoxb-wrong');
		await button(wrapper, 'Verify & save').trigger('click');
		await flushPromises();
		expect(wrapper.get('[data-testid="slack-step-token"] [role="alert"]').text()).toContain(
			'invalid_auth',
		);
		expect(stepState(wrapper, 'token')).toBe('current');
		wrapper.unmount();
	});

	it('shows channel loading errors with Try again', async () => {
		onGet(URL, () => ({ configured: true, integration: PENDING, manifest: MANIFEST }));
		onPost(`${URL}/discover`, () => new MockApiError('Slack is unreachable', 502, 'slack_failed'));
		const wrapper = await mountCard();
		const alert = wrapper.get('[data-testid="slack-step-channel"] [role="alert"]');
		expect(alert.text()).toContain('Slack is unreachable');
		expect(alert.text()).toContain('Try again');
		wrapper.unmount();
	});
});
