// @vitest-environment jsdom
// Same environment as issue-detail.test.ts (the view renders markdown).
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useToast } from '../composables/useToast';
import IssueDetail from '../views/IssueDetail.vue';
import { seedAuth } from './helpers';
import { MockApiError, mockApi, onGet, onPost, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const ISSUE_URL = '/api/projects/demo/issues/issue-1';

const LINK = {
	integrationId: 'int-1',
	type: 'kaneo',
	externalId: 'task-1',
	externalUrl: 'https://kaneo.example.com/dashboard/workspace/ws1/project/kp1/task/task-1',
	externalKey: 'SNT-12',
	createdAt: '2026-11-25T10:00:00Z',
};

async function mountIssue(
	extra: { links?: unknown[]; availableIntegrations?: string[] },
	activity: unknown[] = [],
) {
	onGet(ISSUE_URL, () => ({
		issue: {
			id: 'issue-1',
			title: 'TypeError',
			culprit: null,
			level: 'error',
			platform: 'javascript',
			firstSeen: '2026-11-25T09:00:00Z',
			lastSeen: '2026-11-25T10:00:00Z',
			count: 3,
			userCount: 1,
			status: 'unresolved',
			snoozedUntil: null,
			metadata: { type: 'TypeError', value: 'x is undefined' },
		},
		...extra,
	}));
	onGet(`${ISSUE_URL}/events?limit=10`, () => ({
		events: [
			{
				event_id: 'evt-1',
				timestamp: '2026-11-25T10:00:00Z',
				level: 'error',
				platform: 'javascript',
				exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
			},
		],
	}));
	onGet(`${ISSUE_URL}/activity`, () => ({ activity }));

	const { pinia } = seedAuth();
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/projects/:slug/issues/:issueId', component: { template: '<div />' } },
			{ path: '/projects/:slug/issues', component: { template: '<div />' } },
		],
	});
	await router.push('/projects/demo/issues/issue-1');
	await router.isReady();
	const wrapper = mount(IssueDetail, {
		global: { plugins: [pinia, router], stubs: { AttachmentList: true } },
	});
	await flushPromises();
	return wrapper;
}

beforeEach(() => resetMocks());
afterEach(() => useToast().clear());

describe('issue Kaneo card', () => {
	it('is absent when the project has no Kaneo connection', async () => {
		const wrapper = await mountIssue({ links: [], availableIntegrations: [] });
		expect(wrapper.find('[data-testid="issue-kaneo"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('links to the existing task in a new tab', async () => {
		const wrapper = await mountIssue({ links: [LINK], availableIntegrations: ['kaneo'] });
		const card = wrapper.get('[data-testid="issue-kaneo"]');
		const link = card.get('a');
		expect(link.text()).toBe('SNT-12');
		expect(link.attributes('href')).toBe(LINK.externalUrl);
		expect(link.attributes('target')).toBe('_blank');
		expect(link.attributes('rel')).toContain('noopener');
		expect(card.find('button').exists()).toBe(false);
		wrapper.unmount();
	});

	it('creates the task and shows its key', async () => {
		onPost(`${ISSUE_URL}/links/kaneo`, () => ({ link: LINK, created: true }));
		const wrapper = await mountIssue({ links: [], availableIntegrations: ['kaneo'] });
		const card = wrapper.get('[data-testid="issue-kaneo"]');
		expect(card.text()).toContain('No task yet');
		await card.get('button').trigger('click');
		await flushPromises();
		expect(
			mockApi.calls.some((c) => c.method === 'post' && c.url === `${ISSUE_URL}/links/kaneo`),
		).toBe(true);
		expect(wrapper.get('[data-testid="issue-kaneo"] a').text()).toBe('SNT-12');
		expect(useToast().toasts.at(-1)?.message).toBe('Task SNT-12 created in Kaneo');
		wrapper.unmount();
	});

	it('reports a Kaneo failure and keeps the button', async () => {
		onPost(
			`${ISSUE_URL}/links/kaneo`,
			() => new MockApiError('Kaneo answered 500', 502, 'kaneo_failed'),
		);
		const wrapper = await mountIssue({ links: [], availableIntegrations: ['kaneo'] });
		await wrapper.get('[data-testid="issue-kaneo"] button').trigger('click');
		await flushPromises();
		expect(useToast().toasts.at(-1)?.message).toBe('Kaneo answered 500');
		expect(wrapper.get('[data-testid="issue-kaneo"]').find('button').exists()).toBe(true);
		wrapper.unmount();
	});

	it('explains regressions in the activity', async () => {
		const wrapper = await mountIssue({ links: [], availableIntegrations: [] }, [
			{
				id: 'a1',
				issueId: 'issue-1',
				userId: 'system',
				userName: 'System',
				type: 'status_change',
				data: { from: 'resolved', to: 'unresolved', reason: 'regression' },
				createdAt: '2026-11-25T10:00:00Z',
			},
		]);
		expect(wrapper.text()).toContain('Regression:');
		expect(wrapper.text()).toContain('a new event arrived after it was resolved');
		wrapper.unmount();
	});
});
