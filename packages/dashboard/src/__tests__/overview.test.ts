import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectOverview from '../views/ProjectOverview.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { MockApiError, onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const hour = (h: number) => new Date(Date.UTC(2026, 10, 24, h)).toISOString();

const SUMMARY = {
	issuesByStatus: { unresolved: 1284, resolved: 3 },
	events24h: 3912,
	events7d: 24580,
	totalUsers: 1207,
	trend: [
		{ bucket: hour(10), count: 4 },
		{ bucket: hour(11), count: 212 },
		{ bucket: hour(12), count: 9 },
	],
	topIssues: [
		{
			id: 'i1',
			title: "TypeError: Cannot read properties of undefined (reading 'id')",
			culprit: 'src/routes/checkout.ts in handleSubmit',
			level: 'error',
			lastSeen: hour(23),
			firstSeen: hour(10),
			count: 1284,
			userCount: 342,
			metadata: { type: 'TypeError', value: "Cannot read properties of undefined (reading 'id')" },
		},
	],
};

async function mountOverview() {
	const { pinia } = seedAuth({});
	const router = testRouter();
	await atRoute(router, '/projects/web-frontend/overview');
	const wrapper = mount(ProjectOverview, {
		attachTo: document.body,
		global: { plugins: [pinia, router] },
	});
	return wrapper;
}

describe('project overview', () => {
	// Fixed clock: the chart shows the 7 days ending at the current hour.
	beforeEach(() => {
		vi.useFakeTimers({ now: new Date(Date.UTC(2026, 10, 24, 23, 30)), toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders metric cards that link to the filtered issue list', async () => {
		onGet('/api/projects/web-frontend/summary', () => SUMMARY);
		const wrapper = await mountOverview();
		expect(wrapper.find('[data-testid="overview-loading"]').exists()).toBe(true);
		await flushPromises();

		const stats = wrapper.findAll('section[aria-label="Key metrics"] a');
		expect(stats.map((a) => a.attributes('href'))).toEqual([
			'/projects/web-frontend/issues?status=unresolved',
			'/projects/web-frontend/issues?status=',
			'/projects/web-frontend/issues?status=',
			'/projects/web-frontend/issues?sort=user',
		]);
		expect(stats[0].text()).toContain('1,284');
		expect(stats[3].text()).toContain('1,207');
		wrapper.unmount();
	});

	it('draws the trend with a keyboard-readable chart and a screen-reader table', async () => {
		onGet('/api/projects/web-frontend/summary', () => SUMMARY);
		const wrapper = await mountOverview();
		await flushPromises();

		expect(wrapper.text()).toContain('peak 212 events');
		// 168 hourly buckets, empty hours filled with zero
		expect(wrapper.findAll('[data-testid="trend-chart"] rect')).toHaveLength(168);
		const chart = wrapper.get('[data-testid="trend-chart"]');
		expect(chart.attributes('tabindex')).toBe('0');
		await chart.trigger('keydown', { key: 'End' });
		expect(wrapper.get('[aria-live="polite"]').text()).toContain('0 events');
		for (let i = 0; i < 12; i++) await chart.trigger('keydown', { key: 'ArrowLeft' });
		expect(wrapper.get('[aria-live="polite"]').text()).toContain('212 events');
		// Daily totals for assistive tech
		expect(wrapper.get('table caption').text()).toContain('totals per day');
		const totals = wrapper.findAll('table tbody td:last-child').map((td) => Number(td.text()));
		expect(totals.reduce((a, b) => a + b, 0)).toBe(225);
		expect(totals).toContain(225);
		wrapper.unmount();
	});

	it('lists top issues linking to their detail page', async () => {
		onGet('/api/projects/web-frontend/summary', () => SUMMARY);
		const wrapper = await mountOverview();
		await flushPromises();
		const row = wrapper.get('ul a');
		expect(row.attributes('href')).toBe('/projects/web-frontend/issues/i1');
		expect(row.text()).toContain('TypeError');
		expect(row.text()).toContain('src/routes/checkout.ts in handleSubmit');
		expect(row.text()).toContain('first seen 13h ago');
		wrapper.unmount();
	});

	it('shows empty chart and issue states', async () => {
		onGet('/api/projects/web-frontend/summary', () => ({ ...SUMMARY, trend: [], topIssues: [] }));
		const wrapper = await mountOverview();
		await flushPromises();
		expect(wrapper.text()).toContain('No events recorded yet');
		expect(wrapper.text()).toContain('No unresolved issues');
		wrapper.unmount();
	});

	it('shows an error with a retry', async () => {
		let fail = true;
		onGet('/api/projects/web-frontend/summary', () => {
			if (fail) throw new MockApiError('Summary unavailable', 503, 'unavailable');
			return SUMMARY;
		});
		const wrapper = await mountOverview();
		await flushPromises();
		expect(wrapper.get('[role="alert"]').text()).toContain('Summary unavailable');
		fail = false;
		await wrapper.get('[role="alert"] button').trigger('click');
		await flushPromises();
		expect(wrapper.find('section[aria-label="Key metrics"]').exists()).toBe(true);
		wrapper.unmount();
	});
});
