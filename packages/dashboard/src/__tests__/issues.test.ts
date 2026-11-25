import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import Issues from '../views/Issues.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { MockApiError, mockApi, onGet, onPatch, onPost } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const BASE = '/api/projects/web-frontend';
const now = new Date().toISOString();
const issue = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: `${type}: boom`,
	culprit: `src/${id}.ts in run`,
	level: 'error',
	platform: 'javascript',
	firstSeen: now,
	lastSeen: now,
	count: 1284,
	userCount: 342,
	status: 'unresolved',
	snoozedUntil: null,
	metadata: { type, value: 'boom' },
	...extra,
});

function mockLists(
	issues = [issue('i1', 'TypeError'), issue('i2', 'RangeError'), issue('i3', 'SyntaxError')],
) {
	onGet(`${BASE}/issues?status=unresolved&limit=25`, () => ({ issues, hasMore: false }));
	onGet(`${BASE}/tags?limit=10`, () => ({
		facets: [
			{
				key: 'browser',
				issueCount: 3,
				eventCount: 9,
				topValues: [{ value: 'Chrome', issueCount: 2, eventCount: 6 }],
			},
		],
	}));
	onGet(`${BASE}/environments`, () => ({
		environments: [{ name: 'production', issueCount: 3, lastSeen: now }],
	}));
}

async function mountIssues(path = '/projects/web-frontend/issues') {
	const { pinia } = seedAuth({});
	const router = testRouter();
	await atRoute(router, path);
	const wrapper = mount(Issues, { attachTo: document.body, global: { plugins: [pinia, router] } });
	await flushPromises();
	return { wrapper, router };
}

async function selectRows(
	wrapper: Awaited<ReturnType<typeof mountIssues>>['wrapper'],
	indexes: number[],
) {
	const rows = wrapper.findAll('[data-testid="issue-row"]');
	for (const i of indexes) await rows[i].get('input[type="checkbox"]').setValue(true);
}

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('issues list', () => {
	it('renders a semantic table with linked rows', async () => {
		mockLists();
		const { wrapper } = await mountIssues();
		expect(wrapper.find('table caption').text()).toBe('Issues');
		const rows = wrapper.findAll('[data-testid="issue-row"]');
		expect(rows).toHaveLength(3);
		expect(rows[0].get('a').attributes('href')).toBe('/projects/web-frontend/issues/i1');
		expect(rows[0].text()).toContain('TypeError');
		expect(rows[0].text()).toContain('1,284');
		wrapper.unmount();
	});

	it('switches status from the tabs', async () => {
		mockLists();
		onGet(`${BASE}/issues?status=resolved&limit=25`, () => ({ issues: [], hasMore: false }));
		const { wrapper } = await mountIssues();
		const resolved = wrapper.findAll('[role="tab"]').find((t) => t.text() === 'Resolved');
		await resolved?.trigger('click');
		await flushPromises();
		expect(mockApi.calls.some((c) => c.url === `${BASE}/issues?status=resolved&limit=25`)).toBe(
			true,
		);
		expect(wrapper.text()).toContain('No issues match');
		wrapper.unmount();
	});

	it('filters by tag and removes the filter from its chip', async () => {
		mockLists();
		onGet(`${BASE}/issues?status=unresolved&limit=25&tag=browser%3AChrome`, () => ({
			issues: [issue('i1', 'TypeError')],
			hasMore: false,
		}));
		const { wrapper } = await mountIssues();
		const select = wrapper.get('select[aria-label="Tag browser"]');
		await select.setValue('Chrome');
		await flushPromises();
		expect(wrapper.findAll('[data-testid="issue-row"]')).toHaveLength(1);
		const chip = wrapper.get('[data-testid="active-filters"]');
		expect(chip.text()).toContain('browser: Chrome');
		await chip.get('button[aria-label="Remove filter browser:Chrome"]').trigger('click');
		await flushPromises();
		expect(wrapper.findAll('[data-testid="issue-row"]')).toHaveLength(3);
		wrapper.unmount();
	});

	it('bulk deletes only after the danger confirmation', async () => {
		mockLists();
		onPatch(`${BASE}/issues/bulk`, () => ({ success: true }));
		const { wrapper } = await mountIssues();
		await selectRows(wrapper, [0, 1]);
		const bar = wrapper.get('[data-testid="bulk-bar"]');
		expect(bar.text()).toContain('2 issues selected');

		const deleteBtn = bar.findAll('button').find((b) => b.text() === 'Delete');
		await deleteBtn?.trigger('click');
		await flushPromises();
		expect(confirmState.current?.title).toBe('Delete 2 issues?');
		expect(confirmState.current?.tone).toBe('danger');
		expect(confirmState.current?.items).toEqual(['TypeError: boom', 'RangeError: boom']);

		// Cancel: nothing sent
		settleConfirm(false);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'patch')).toBe(false);

		// Confirm: sent, rows removed, success toast
		await deleteBtn?.trigger('click');
		await flushPromises();
		settleConfirm(true);
		await flushPromises();
		const call = mockApi.calls.find((c) => c.method === 'patch');
		expect(call?.body).toEqual({ issueIds: ['i1', 'i2'], action: 'delete' });
		expect(wrapper.findAll('[data-testid="issue-row"]')).toHaveLength(1);
		expect(useToast().toasts.at(-1)?.message).toBe('2 issues deleted');
		wrapper.unmount();
	});

	it('reports a failed merge with a toast instead of alert()', async () => {
		mockLists();
		onPost(`${BASE}/issues/merge`, () => {
			throw new MockApiError('different projects', 400, 'bad_request');
		});
		const alertSpy = vi.spyOn(window, 'alert');
		const { wrapper } = await mountIssues();
		await selectRows(wrapper, [0, 2]);
		await wrapper
			.get('[data-testid="bulk-bar"]')
			.findAll('button')
			.find((b) => b.text() === 'Merge')
			?.trigger('click');
		await flushPromises();
		expect(confirmState.current?.title).toBe('Merge 2 issues?');
		settleConfirm(true);
		await flushPromises();
		expect(alertSpy).not.toHaveBeenCalled();
		const last = useToast().toasts.at(-1);
		expect(last?.kind).toBe('error');
		expect(last?.message).toContain('Failed to merge issues');
		alertSpy.mockRestore();
		wrapper.unmount();
	});

	it('clears the selection with Escape', async () => {
		mockLists();
		const { wrapper } = await mountIssues();
		await selectRows(wrapper, [0]);
		expect(wrapper.find('[data-testid="bulk-bar"]').exists()).toBe(true);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await flushPromises();
		expect(wrapper.find('[data-testid="bulk-bar"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('points an empty project to the SDK setup page', async () => {
		mockLists([]);
		const { wrapper } = await mountIssues();
		const link = wrapper.get('[data-testid="empty-setup-link"]');
		expect(link.attributes('href')).toBe('/setup?project=web-frontend');
		expect(wrapper.text()).toContain('No issues yet');
		wrapper.unmount();
	});

	it('keeps deep links from the overview cards', async () => {
		mockLists();
		onGet(`${BASE}/issues?sort=user_count&limit=25`, () => ({
			issues: [issue('i1', 'TypeError')],
			hasMore: false,
		}));
		const { wrapper } = await mountIssues('/projects/web-frontend/issues?status=&sort=user');
		expect(mockApi.calls.some((c) => c.url === `${BASE}/issues?sort=user_count&limit=25`)).toBe(
			true,
		);
		expect(
			wrapper
				.findAll('[role="tab"]')
				.find((t) => t.attributes('aria-selected') === 'true')
				?.text(),
		).toBe('All');
		wrapper.unmount();
	});
});
