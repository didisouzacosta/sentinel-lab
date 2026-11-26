import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppSetupStep from '../components/app/AppSetupStep.vue';
import UiExternalLink from '../components/ui/UiExternalLink.vue';
import UiStatus from '../components/ui/UiStatus.vue';
import { kaneoLinks, parseSlackAppId, slackLinks } from '../lib/integration-links';
import type { KaneoIntegration, SlackIntegration } from '../lib/integrations';
import { type ProjectRole, useProjectsStore } from '../stores/projects';
import ProjectIntegration from '../views/ProjectIntegration.vue';
import ProjectIntegrations from '../views/ProjectIntegrations.vue';
import { seedAuth } from './helpers';
import { mockApi, onGet, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const BASE = '/api/projects/web-frontend';

const SLACK = {
	id: 's',
	enabled: true,
	status: 'connected',
	appId: null,
	teamId: 'T',
	teamName: 'Acme',
	botUserId: 'U',
	channelId: 'C0ERRORS',
	channelName: 'th-errors',
	channelPrivate: false,
	minLevel: 'error',
	environments: [],
	notifyRegression: true,
	notifyResolved: true,
	botToken: 'xoxb…oken',
	credentialsReadable: true,
	lastError: null,
	lastErrorAt: null,
} satisfies SlackIntegration;

const KANEO = {
	id: 'k',
	enabled: true,
	status: 'connected',
	baseUrl: 'https://kaneo.example.com',
	workspaceId: 'ws1',
	workspaceName: 'Personal',
	kaneoProjectId: 'kp1',
	kaneoProjectName: 'TenhoHorario',
	kaneoProjectSlug: 'TH',
	createColumn: 'to-do',
	doneColumn: 'done',
	reopenColumn: 'to-do',
	autoCreate: true,
	minLevel: 'error',
	environments: [],
	apiKey: 'kane…6789',
	credentialsReadable: true,
	lastError: null,
	lastErrorAt: null,
	webhookStatus: 'in_use',
	webhookError: 'already has a webhook',
} satisfies KaneoIntegration;

async function mountView(
	component: typeof ProjectIntegrations | typeof ProjectIntegration,
	path: string,
	role: ProjectRole = 'owner',
) {
	const { pinia } = seedAuth({});
	useProjectsStore(pinia).projects = [
		{
			id: 'proj-1',
			name: 'Web Frontend',
			slug: 'web-frontend',
			platform: 'javascript',
			memberRole: role,
		},
	];
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/projects/:slug/integrations', component: { template: '<div />' } },
			{ path: '/projects/:slug/integrations/:kind', component: { template: '<div />' } },
		],
	});
	await router.push(path);
	await router.isReady();
	const wrapper = mount(component, {
		attachTo: document.body,
		global: { plugins: [pinia, router] },
	});
	await flushPromises();
	return wrapper;
}

beforeEach(() => resetMocks());
afterEach(() => {
	document.body.innerHTML = '';
});

describe('Integrations overview', () => {
	it('shows each integration with its status, summary and action', async () => {
		onGet(BASE, () => ({ project: { webhookUrl: null } }));
		onGet(`${BASE}/integrations/slack`, () => ({ configured: true, integration: SLACK }));
		onGet(`${BASE}/integrations/kaneo`, () => ({ configured: true, integration: KANEO }));
		const wrapper = await mountView(ProjectIntegrations, '/projects/web-frontend/integrations');

		const card = (key: string) => wrapper.get(`[data-testid="integration-${key}"]`);
		expect(card('slack').get('[data-state]').attributes('data-state')).toBe('connected');
		expect(card('slack').text()).toContain('#th-errors · error and above');
		expect(card('slack').get('a').attributes('href')).toBe(
			'/projects/web-frontend/integrations/slack',
		);
		expect(card('slack').get('a').text()).toBe('Manage');

		expect(card('kaneo').get('[data-state]').attributes('data-state')).toBe('attention');
		expect(card('kaneo').text()).toContain('TenhoHorario (TH) · two-way sync off');
		expect(card('kaneo').get('a').text()).toBe('Fix');

		expect(card('webhook').get('[data-state]').attributes('data-state')).toBe('off');
		expect(card('webhook').get('a').text()).toBe('Set up');
		expect(wrapper.text()).toContain('Slack and Kaneo work independently');
		wrapper.unmount();
	});

	it('marks a saved-but-unfinished integration as setup incomplete', async () => {
		onGet(BASE, () => ({ project: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' } }));
		onGet(`${BASE}/integrations/slack`, () => ({
			configured: true,
			integration: { ...SLACK, status: 'pending', channelId: '', channelName: '' },
		}));
		onGet(`${BASE}/integrations/kaneo`, () => ({ configured: true, integration: null }));
		const wrapper = await mountView(ProjectIntegrations, '/projects/web-frontend/integrations');
		const slack = wrapper.get('[data-testid="integration-slack"]');
		expect(slack.get('[data-state]').attributes('data-state')).toBe('pending');
		expect(slack.get('a').text()).toBe('Continue');
		const webhook = wrapper.get('[data-testid="integration-webhook"]');
		expect(webhook.get('[data-state]').attributes('data-state')).toBe('connected');
		expect(webhook.text()).toContain('discord.com');
		wrapper.unmount();
	});

	it('blocks Slack and Kaneo without INTEGRATIONS_KEY but keeps the webhook', async () => {
		onGet(BASE, () => ({ project: { webhookUrl: null } }));
		onGet(`${BASE}/integrations/slack`, () => ({ configured: false, integration: null }));
		onGet(`${BASE}/integrations/kaneo`, () => ({ configured: false, integration: null }));
		const wrapper = await mountView(ProjectIntegrations, '/projects/web-frontend/integrations');
		expect(wrapper.get('[data-testid="integrations-unconfigured"]').text()).toContain(
			'INTEGRATIONS_KEY',
		);
		expect(wrapper.get('[data-testid="integration-slack"]').find('a').exists()).toBe(false);
		expect(wrapper.get('[data-testid="integration-webhook"]').get('a').text()).toBe('Set up');
		wrapper.unmount();
	});

	it('shows members what each integration does without asking for owner-only data', async () => {
		onGet(BASE, () => ({ project: { webhookUrl: null } }));
		const wrapper = await mountView(
			ProjectIntegrations,
			'/projects/web-frontend/integrations',
			'member',
		);
		expect(wrapper.text()).toContain('Only project owners and admins can set up integrations');
		expect(mockApi.calls.some((c) => c.url.includes('/integrations/'))).toBe(false);
		expect(wrapper.get('[data-testid="integration-slack"]').find('[data-state]').exists()).toBe(
			false,
		);
		expect(wrapper.find('[data-testid="integration-cards"] a').exists()).toBe(false);
		wrapper.unmount();
	});

	it('opens the page of one integration from its route', async () => {
		onGet(`${BASE}/integrations/slack`, () => ({
			configured: true,
			integration: null,
			manifest: null,
		}));
		const wrapper = await mountView(
			ProjectIntegration,
			'/projects/web-frontend/integrations/slack',
		);
		expect(wrapper.get('h1').text()).toBe('Slack');
		expect(wrapper.find('[data-testid="slack-integration"]').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('integration links and components', () => {
	it('builds the deep links without ever reading a credential', () => {
		expect(parseSlackAppId('https://api.slack.com/apps/A08K2TX4R1Q/general')).toBe('A08K2TX4R1Q');
		expect(parseSlackAppId('not an app')).toBeNull();
		expect(slackLinks.oauth('A08K2TX4R1Q')).toBe('https://api.slack.com/apps/A08K2TX4R1Q/oauth');
		expect(slackLinks.install(null)).toBe('https://api.slack.com/apps');
		expect(kaneoLinks.apiKeys('kaneo.example.com/api/')).toBe(
			'https://kaneo.example.com/dashboard/settings/account/developer',
		);
		expect(kaneoLinks.apiKeys('')).toBeNull();
	});

	it('UiStatus labels each connection state', () => {
		const labels = (['connected', 'pending', 'attention', 'off'] as const).map((state) =>
			mount(UiStatus, { props: { state } }).text(),
		);
		expect(labels).toEqual(['Connected', 'Setup incomplete', 'Needs attention', 'Not connected']);
	});

	it('UiExternalLink opens a new tab safely and is inert without a URL', () => {
		const link = mount(UiExternalLink, {
			props: { href: 'https://example.com' },
			slots: { default: 'Go' },
		});
		expect(link.get('a').attributes()).toMatchObject({
			target: '_blank',
			rel: 'noopener noreferrer',
		});
		expect(link.text()).toContain('(opens in a new tab)');
		const inert = mount(UiExternalLink, { props: { href: null }, slots: { default: 'Go' } });
		expect(inert.find('a').exists()).toBe(false);
		expect(inert.get('[aria-disabled="true"]').text()).toContain('Go');
	});

	it('AppSetupStep shows content only when current, a check when done and a hint when locked', () => {
		const current = mount(AppSetupStep, {
			props: { number: 2, title: 'Token', state: 'current' },
			slots: { default: '<input data-testid="body" />' },
		});
		expect(current.find('[data-testid="body"]').exists()).toBe(true);
		expect(current.get('li').attributes('aria-current')).toBe('step');

		const done = mount(AppSetupStep, {
			props: { number: 2, title: 'Token', state: 'done', description: 'Verified' },
			slots: { default: '<input data-testid="body" />', actions: '<button>Change</button>' },
		});
		expect(done.find('[data-testid="body"]').exists()).toBe(false);
		expect(done.find('[aria-label="Done"]').exists()).toBe(true);
		expect(done.text()).toContain('Verified');
		expect(done.text()).toContain('Change');

		const locked = mount(AppSetupStep, {
			props: { number: 3, title: 'Channel', state: 'locked', lockedHint: 'Complete step 2 first' },
		});
		expect(locked.get('li').attributes('aria-disabled')).toBe('true');
		expect(locked.text()).toContain('Complete step 2 first');
	});
});
