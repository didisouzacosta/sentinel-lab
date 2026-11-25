import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import ReleaseDetail from '../views/ReleaseDetail.vue';
import Releases from '../views/Releases.vue';
import { seedAuth } from './helpers';
import { MockApiError, mockApi, onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const BASE = '/api/projects/web-frontend';
const now = new Date().toISOString();

async function mountAt(component: typeof Releases | typeof ReleaseDetail, path: string) {
	const { pinia } = seedAuth({});
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/projects/:slug/releases', component: { template: '<div />' } },
			{ path: '/projects/:slug/releases/:version', component: { template: '<div />' } },
			{ path: '/projects/:slug/issues/:issueId', component: { template: '<div />' } },
			{ path: '/setup', component: { template: '<div />' } },
		],
	});
	await router.push(path);
	await router.isReady();
	const wrapper = mount(component, { global: { plugins: [pinia, router] } });
	await flushPromises();
	return wrapper;
}

const release = (version: string, extra: Record<string, unknown> = {}) => ({
	version,
	firstSeen: now,
	lastSeen: now,
	eventCount: 24580,
	issueCount: 37,
	newIssueCount: 0,
	...extra,
});

describe('releases list', () => {
	it('lists versions with numbers, new-issue badges and encoded links', async () => {
		onGet(`${BASE}/releases?`, () => ({
			releases: [release('web@2.14.0', { newIssueCount: 3 }), release('web@2.13.2')],
			hasMore: true,
			nextCursor: 'c2',
		}));
		onGet(`${BASE}/releases?cursor=c2`, () => ({
			releases: [release('web@2.13.1')],
			hasMore: false,
		}));
		const wrapper = await mountAt(Releases, '/projects/web-frontend/releases');

		const rows = wrapper.findAll('[data-testid="release-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0].get('a').attributes('href')).toBe(
			'/projects/web-frontend/releases/web%402.14.0',
		);
		expect(rows[0].text()).toContain('3 new');
		expect(rows[0].text()).toContain('24,580');
		expect(rows[1].text()).not.toContain('new');

		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Load More')
			?.trigger('click');
		await flushPromises();
		expect(wrapper.findAll('[data-testid="release-row"]')).toHaveLength(3);
	});

	it('explains how to get releases when there are none', async () => {
		onGet(`${BASE}/releases?`, () => ({ releases: [], hasMore: false }));
		const wrapper = await mountAt(Releases, '/projects/web-frontend/releases');
		expect(wrapper.text()).toContain('No releases yet');
		expect(wrapper.get('a').attributes('href')).toBe('/setup?project=web-frontend');
	});

	it('retries after an error', async () => {
		let fail = true;
		onGet(`${BASE}/releases?`, () => {
			if (fail) throw new MockApiError('Releases unavailable', 503, 'unavailable');
			return { releases: [release('web@1.0.0')], hasMore: false };
		});
		const wrapper = await mountAt(Releases, '/projects/web-frontend/releases');
		expect(wrapper.get('[role="alert"]').text()).toContain('Releases unavailable');
		fail = false;
		await wrapper.get('[role="alert"] button').trigger('click');
		await flushPromises();
		expect(wrapper.findAll('[data-testid="release-row"]')).toHaveLength(1);
	});
});

describe('release detail', () => {
	it('shows the numbers and the issues of the release', async () => {
		onGet(`${BASE}/releases/web%402.14.0`, () => ({
			release: release('web@2.14.0', { newIssueCount: 1 }),
			issues: [
				{
					id: 'i1',
					title: 'TypeError: boom',
					culprit: 'src/a.ts in run',
					level: 'error',
					platform: 'javascript',
					firstSeen: '2026-11-25T08:00:00Z',
					firstSeenInRelease: '2026-11-25T08:00:00Z',
					lastSeen: now,
					count: 1284,
					userCount: 3,
					status: 'unresolved',
					metadata: { type: 'TypeError', value: 'boom' },
					releaseEventCount: 812,
				},
			],
		}));
		const wrapper = await mountAt(ReleaseDetail, '/projects/web-frontend/releases/web%402.14.0');
		expect(mockApi.calls.some((c) => c.url === `${BASE}/releases/web%402.14.0`)).toBe(true);
		expect(wrapper.get('h1').text()).toBe('web@2.14.0');
		expect(wrapper.text()).toContain('1 new issues');
		const row = wrapper.get('[data-testid="release-issue-row"]');
		expect(row.get('a').attributes('href')).toBe('/projects/web-frontend/issues/i1');
		expect(row.text()).toContain('new');
		expect(row.text()).toContain('812');
		expect(row.text()).toContain('1,284');
	});

	it('handles a release without issues', async () => {
		onGet(`${BASE}/releases/web%401.0.0`, () => ({ release: release('web@1.0.0'), issues: [] }));
		const wrapper = await mountAt(ReleaseDetail, '/projects/web-frontend/releases/web%401.0.0');
		expect(wrapper.text()).toContain('No issues found in this release.');
	});
});
