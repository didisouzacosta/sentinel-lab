import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import Projects from '../views/Projects.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { MockApiError, onGet } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

async function mountProjects() {
	const { pinia } = seedAuth({});
	const router = testRouter();
	await atRoute(router, '/projects');
	return mount(Projects, { global: { plugins: [pinia, router] } });
}

describe('projects page', () => {
	it('lists project cards linking to their issues', async () => {
		onGet('/api/projects', () => ({
			projects: [
				{
					id: 'p1',
					name: 'Web Frontend',
					slug: 'web-frontend',
					platform: 'javascript',
					createdAt: '2026-11-02T10:00:00Z',
				},
				{
					id: 'p2',
					name: 'API Gateway',
					slug: 'api-gateway',
					platform: 'node',
					createdAt: '2026-10-18T10:00:00Z',
				},
			],
		}));
		const wrapper = await mountProjects();
		expect(wrapper.find('[data-testid="projects-loading"]').exists()).toBe(true);
		await flushPromises();

		expect(wrapper.text()).toContain('2 projects you are a member of');
		const cards = wrapper.findAll('li a');
		expect(cards).toHaveLength(2);
		expect(cards[0].attributes('href')).toBe('/projects/web-frontend/issues');
		expect(cards[0].text()).toContain('Web Frontend');
		expect(cards[0].text()).toContain('javascript');
		expect(cards[0].text()).toContain('Created Nov 2, 2026');
		expect(wrapper.find('h1').text()).toBe('Projects');
	});

	it('shows an error with a working retry', async () => {
		let fail = true;
		onGet('/api/projects', () => {
			if (fail) throw new MockApiError('Service unavailable', 503, 'unavailable');
			return { projects: [] };
		});
		const wrapper = await mountProjects();
		await flushPromises();
		const alert = wrapper.get('[role="alert"]');
		expect(alert.text()).toContain('Service unavailable');

		fail = false;
		await alert.get('button').trigger('click');
		await flushPromises();
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('No projects');
	});
});
