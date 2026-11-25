import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { type ProjectRole, useProjectsStore } from '../stores/projects';
import ProjectFilters from '../views/ProjectFilters.vue';
import ProjectSettings from '../views/ProjectSettings.vue';
import { seedAuth } from './helpers';
import { MockApiError, mockApi, onDelete, onGet, onPatch, onPost } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const BASE = '/api/projects/web-frontend';

async function mountAt(
	component: typeof ProjectFilters | typeof ProjectSettings,
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
			{ path: '/projects', component: { template: '<div />' } },
			{ path: '/settings/tokens', component: { template: '<div />' } },
			{ path: '/projects/:slug/filters', component: { template: '<div />' } },
			{ path: '/projects/:slug/settings', component: { template: '<div />' } },
		],
	});
	await router.push(path);
	await router.isReady();
	const wrapper = mount(component, {
		attachTo: document.body,
		global: { plugins: [pinia, router] },
	});
	await flushPromises();
	return { wrapper, router };
}

const filter = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	filterType: 'message',
	pattern: 'ResizeObserver loop',
	enabled: true,
	description: 'Browser noise',
	droppedCount: 4511,
	createdAt: '2026-11-02T00:00:00Z',
	...extra,
});

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('inbound filters', () => {
	it('lists filters with totals and toggles one with a switch', async () => {
		onGet(`${BASE}/filters`, () => ({
			filters: [
				filter('f1'),
				filter('f2', {
					pattern: 'staging',
					filterType: 'environment',
					enabled: false,
					droppedCount: 0,
				}),
			],
		}));
		onPatch(`${BASE}/filters/f2`, () => ({ success: true }));
		const { wrapper } = await mountAt(ProjectFilters, '/projects/web-frontend/filters');

		const rows = wrapper.findAll('[data-testid="filter-row"]');
		expect(rows).toHaveLength(2);
		expect(wrapper.text()).toContain('4,511');
		expect(rows[1].text()).toContain('Environment');
		expect(rows[1].text()).toContain('Paused');

		const toggle = rows[1].get('[role="switch"]');
		expect(toggle.attributes('aria-checked')).toBe('false');
		await toggle.trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'patch')?.body).toEqual({ enabled: true });
		expect(toggle.attributes('aria-checked')).toBe('true');
		expect(useToast().toasts.at(-1)?.message).toBe('Filter enabled');
		wrapper.unmount();
	});

	it('reverts the switch when saving fails', async () => {
		onGet(`${BASE}/filters`, () => ({ filters: [filter('f1')] }));
		onPatch(`${BASE}/filters/f1`, () => {
			throw new MockApiError('Nope', 500, 'error');
		});
		const { wrapper } = await mountAt(ProjectFilters, '/projects/web-frontend/filters');
		const toggle = wrapper.get('[role="switch"]');
		await toggle.trigger('click');
		await flushPromises();
		expect(toggle.attributes('aria-checked')).toBe('true');
		expect(useToast().toasts.at(-1)?.message).toBe('Nope');
		wrapper.unmount();
	});

	it('asks before deleting a filter', async () => {
		onGet(`${BASE}/filters`, () => ({ filters: [filter('f1')] }));
		onDelete(`${BASE}/filters/f1`, () => ({ success: true }));
		const { wrapper } = await mountAt(ProjectFilters, '/projects/web-frontend/filters');

		await wrapper.get('button[aria-label^="Delete filter"]').trigger('click');
		await flushPromises();
		expect(confirmState.current?.tone).toBe('danger');
		settleConfirm(false);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete')).toBe(false);

		await wrapper.get('button[aria-label^="Delete filter"]').trigger('click');
		await flushPromises();
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete')).toBe(true);
		expect(wrapper.findAll('[data-testid="filter-row"]')).toHaveLength(0);
		wrapper.unmount();
	});

	it('creates a filter from a suggestion in a dialog', async () => {
		let created = false;
		onGet(`${BASE}/filters`, () => ({
			filters: created
				? [filter('f9', { filterType: 'error_type', pattern: 'ChunkLoadError' })]
				: [],
		}));
		onPost(`${BASE}/filters`, () => {
			created = true;
			return { filter: {} };
		});
		const { wrapper } = await mountAt(ProjectFilters, '/projects/web-frontend/filters');
		expect(wrapper.get('[data-testid="filters-empty"]').text()).toContain(
			'No filters configured yet',
		);

		await wrapper
			.get('button[aria-label="Add filter: Webpack chunk loading failures"]')
			.trigger('click');
		await flushPromises();
		const dialog = wrapper.get('[data-testid="filter-dialog"]');
		expect((dialog.element as HTMLDialogElement).open).toBe(true);
		expect((wrapper.get('[data-testid="filter-pattern"]').element as HTMLInputElement).value).toBe(
			'ChunkLoadError',
		);
		expect((wrapper.get('[data-testid="filter-type"]').element as HTMLSelectElement).value).toBe(
			'error_type',
		);

		await dialog.get('form').trigger('submit');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'post')?.body).toEqual({
			filterType: 'error_type',
			pattern: 'ChunkLoadError',
			description: 'Webpack chunk loading failures',
		});
		expect(wrapper.findAll('[data-testid="filter-row"]')).toHaveLength(1);
		expect(useToast().toasts.at(-1)?.message).toBe('Filter created');
		wrapper.unmount();
	});
});

function mockProject(
	extra: { sourceMaps?: unknown[]; maxEventsPerHour?: number; currentHourCount?: number } = {},
) {
	onGet(BASE, () => ({
		project: {
			id: 'proj-1',
			name: 'Web Frontend',
			slug: 'web-frontend',
			platform: 'javascript',
			publicKey: 'pk',
			createdAt: '2026-02-01T00:00:00Z',
		},
		dsn: 'https://pk@sentinel.local/proj-1',
	}));
	onGet(`${BASE}/settings`, () => ({ retentionDays: 90 }));
	onGet(`${BASE}/sourcemaps`, () => ({ sourceMaps: extra.sourceMaps ?? [] }));
	onGet(`${BASE}/rate-limit`, () => ({
		maxEventsPerHour: extra.maxEventsPerHour ?? 0,
		currentHourCount: extra.currentHourCount ?? 0,
		isLimited: false,
	}));
	onGet(`${BASE}/members`, () => ({ members: [] }));
}

describe('project settings', () => {
	it('shows the DSN with a copy button, the section nav and the usage meter', async () => {
		mockProject({ maxEventsPerHour: 5000, currentHourCount: 4912 });
		const { wrapper } = await mountAt(ProjectSettings, '/projects/web-frontend/settings');
		expect(wrapper.get('output[aria-label="DSN"]').text()).toBe('https://pk@sentinel.local/proj-1');
		expect(wrapper.find('button[aria-label="Copy DSN"]').exists()).toBe(true);
		const nav = wrapper.get('nav[aria-label="Settings sections"]');
		expect(nav.findAll('a')).toHaveLength(10);
		expect(nav.get('a[href="#danger"]').text()).toBe('Danger zone');
		const usage = wrapper.get('[data-testid="rate-limit-usage"]');
		expect(usage.text()).toContain('4,912 / 5,000');
		expect(usage.get('[role="meter"]').attributes('aria-valuenow')).toBe('4912');
		expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('90');
		wrapper.unmount();
	});

	it('saves the rate limit with feedback', async () => {
		mockProject();
		onPatch(BASE, () => ({ success: true }));
		const { wrapper } = await mountAt(ProjectSettings, '/projects/web-frontend/settings');
		const form = wrapper.get('#rate-limit form');
		await form.get('input').setValue('2000');
		await form.trigger('submit');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'patch')?.body).toEqual({
			maxEventsPerHour: 2000,
		});
		expect(useToast().toasts.at(-1)?.message).toBe('Rate limit saved');
		wrapper.unmount();
	});

	it('asks before deleting a source map', async () => {
		mockProject({
			sourceMaps: [
				{
					id: 'sm1',
					release: 'web@2.14.0',
					fileUrl: 'https://x/main.js',
					createdAt: '2026-11-24T00:00:00Z',
					size: 421888,
				},
			],
		});
		onDelete(`${BASE}/sourcemaps/sm1`, () => ({ success: true }));
		const { wrapper } = await mountAt(ProjectSettings, '/projects/web-frontend/settings');
		const row = wrapper.get('[data-testid="sourcemap-row"]');
		expect(row.text()).toContain('412.0 KB');
		await row.get('button').trigger('click');
		await flushPromises();
		expect(confirmState.current?.items).toEqual(['web@2.14.0 · https://x/main.js']);
		settleConfirm(true);
		await flushPromises();
		expect(
			mockApi.calls.some((c) => c.method === 'delete' && c.url === `${BASE}/sourcemaps/sm1`),
		).toBe(true);
		expect(wrapper.findAll('[data-testid="sourcemap-row"]')).toHaveLength(0);
		wrapper.unmount();
	});

	it('hides source map deletion from plain members', async () => {
		mockProject({
			sourceMaps: [
				{
					id: 'sm1',
					release: 'web@2.14.0',
					fileUrl: 'https://x/main.js',
					createdAt: '2026-11-24T00:00:00Z',
					size: 421888,
				},
			],
		});
		const { wrapper } = await mountAt(ProjectSettings, '/projects/web-frontend/settings', 'member');
		const row = wrapper.get('[data-testid="sourcemap-row"]');
		expect(row.find('button[aria-label^="Delete source map"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('requires typing the project name to delete it', async () => {
		mockProject();
		onDelete(BASE, () => ({ success: true }));
		const { wrapper, router } = await mountAt(ProjectSettings, '/projects/web-frontend/settings');
		await wrapper.get('[data-testid="delete-project"]').trigger('click');
		await flushPromises();
		expect(confirmState.current).toMatchObject({ tone: 'danger', requireText: 'Web Frontend' });
		settleConfirm(true);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete' && c.url === BASE)).toBe(true);
		expect(router.currentRoute.value.path).toBe('/projects');
		wrapper.unmount();
	});
});

describe('section nav', () => {
	it('highlights the first visible section even when only another one changed', async () => {
		let callback: IntersectionObserverCallback = () => {};
		class FakeObserver {
			constructor(cb: IntersectionObserverCallback) {
				callback = cb;
			}
			observe() {}
			disconnect() {}
		}
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		document.body.innerHTML = '<section id="a"></section><section id="b"></section>';
		const { default: AppSectionNav } = await import('../components/app/AppSectionNav.vue');
		const wrapper = mount(AppSectionNav, {
			attachTo: document.body,
			props: {
				items: [
					{ id: 'a', label: 'A' },
					{ id: 'b', label: 'B' },
				],
			},
		});
		const entry = (id: string, isIntersecting: boolean) =>
			({
				target: document.getElementById(id),
				isIntersecting,
			}) as unknown as IntersectionObserverEntry;
		const current = () => wrapper.get('[aria-current="location"]').text();

		callback([entry('b', true)], {} as IntersectionObserver);
		await flushPromises();
		expect(current()).toBe('B');
		callback([entry('a', true)], {} as IntersectionObserver);
		await flushPromises();
		expect(current()).toBe('A');
		// Only "b" is reported again: "a" is still in view, so it stays highlighted.
		callback([entry('b', true)], {} as IntersectionObserver);
		await flushPromises();
		expect(current()).toBe('A');
		callback([entry('a', false)], {} as IntersectionObserver);
		await flushPromises();
		expect(current()).toBe('B');
		wrapper.unmount();
		vi.unstubAllGlobals();
	});
});
