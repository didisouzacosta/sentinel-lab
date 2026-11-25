import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AttachmentList from '../components/AttachmentList.vue';
import { confirmState, settleConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import IssueDetail from '../views/IssueDetail.vue';
import { seedAuth } from './helpers';
import { mockApi, onDelete, onGet, onPatch, onPost } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('../lib/attachments', async (importOriginal) => {
	const real = await importOriginal<typeof import('../lib/attachments')>();
	return { ...real, downloadAttachment: vi.fn(() => Promise.reject(new Error('network down'))) };
});

const BASE = '/api/projects/demo/issues/issue-1';

const event = {
	event_id: 'evt-1',
	timestamp: '2026-10-11T10:00:00Z',
	level: 'error',
	platform: 'javascript',
	environment: 'production',
	exception: {
		values: [
			{
				type: 'TypeError',
				value: 'boom',
				stacktrace: {
					frames: [
						{ filename: 'lib.js', function: 'inner', lineno: 9, in_app: false },
						{
							filename: 'app.js',
							function: 'chargeOrder',
							lineno: 42,
							in_app: true,
							pre_context: ['const a = 1;'],
							context_line: 'charge(order.id);',
							post_context: ['}'],
						},
					],
				},
			},
		],
	},
};

function mockIssue(activity: unknown[] = []) {
	onGet(BASE, () => ({
		issue: {
			id: 'issue-1',
			title: 'TypeError',
			culprit: 'app.js in chargeOrder',
			level: 'error',
			platform: 'javascript',
			firstSeen: '2026-10-11T09:00:00Z',
			lastSeen: '2026-10-11T10:00:00Z',
			count: 1284,
			userCount: 342,
			status: 'unresolved',
			snoozedUntil: null,
			metadata: { type: 'TypeError', value: 'boom' },
		},
	}));
	onGet(`${BASE}/events?limit=10`, () => ({ events: [event] }));
	onGet(`${BASE}/activity`, () => ({ activity }));
}

async function mountDetail() {
	const { pinia } = seedAuth();
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/projects/:slug/issues/:issueId', component: { template: '<div />' } }],
	});
	await router.push('/projects/demo/issues/issue-1');
	await router.isReady();
	const wrapper = mount(IssueDetail, {
		attachTo: document.body,
		global: { plugins: [pinia, router], stubs: { AttachmentList: true } },
	});
	await flushPromises();
	return wrapper;
}

afterEach(() => {
	confirmState.current = null;
	useToast().clear();
	document.body.innerHTML = '';
});

describe('issue detail interactions', () => {
	it('shows the header, numbers and newest frame first', async () => {
		mockIssue();
		const wrapper = await mountDetail();
		expect(wrapper.get('h1').text()).toContain('TypeError:');
		expect(wrapper.text()).toContain('1,284');
		expect(wrapper.text()).toContain('production');
		const frames = wrapper.findAll('button[aria-controls^="frame-ctx"]');
		expect(frames[0].text()).toContain('chargeOrder');
		expect(frames[0].text()).toContain('in-app');
		wrapper.unmount();
	});

	it('expands a frame to show its context lines', async () => {
		mockIssue();
		const wrapper = await mountDetail();
		const frame = wrapper.findAll('button[aria-controls^="frame-ctx"]')[0];
		expect(frame.attributes('aria-expanded')).toBe('false');
		await frame.trigger('click');
		expect(frame.attributes('aria-expanded')).toBe('true');
		const current = wrapper.get('[aria-current="true"]');
		expect(current.text()).toContain('42');
		expect(current.text()).toContain('charge(order.id);');
		wrapper.unmount();
	});

	it('snoozes from the menu and offers undo', async () => {
		mockIssue();
		const until = new Date(Date.now() + 86_400_000).toISOString();
		onPost(`${BASE}/snooze`, () => ({ issue: { snoozedUntil: until } }));
		const wrapper = await mountDetail();
		const trigger = wrapper
			.findAll('button')
			.find((b) => b.text() === 'Snooze' && b.attributes('aria-haspopup') === 'menu');
		await trigger?.trigger('click');
		await flushPromises();
		const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
			b.textContent?.includes('1 day'),
		);
		item?.click();
		await flushPromises();
		expect(mockApi.calls.find((c) => c.url === `${BASE}/snooze`)?.body).toEqual({ duration: '1d' });
		expect(wrapper.text()).toContain('Snoozed until');
		const toast = useToast().toasts.at(-1);
		expect(toast?.message).toContain('Snoozed until');
		expect(toast?.action?.label).toBe('Undo');
		wrapper.unmount();
	});

	it('resolves with feedback', async () => {
		mockIssue();
		onPatch(BASE, () => ({ success: true }));
		const wrapper = await mountDetail();
		const resolve = wrapper.findAll('button').find((b) => b.text() === 'Resolve');
		await resolve?.trigger('click');
		await flushPromises();
		expect(mockApi.calls.find((c) => c.method === 'patch')?.body).toEqual({ status: 'resolved' });
		expect(useToast().toasts.at(-1)?.message).toBe('Issue resolved');
		wrapper.unmount();
	});

	it('asks before deleting your own comment', async () => {
		mockIssue([
			{
				id: 'a1',
				issueId: 'issue-1',
				userId: 'user-1',
				userName: 'Dev User',
				type: 'comment',
				data: { body: 'Happens with coupons', commentId: 'c1' },
				createdAt: '2026-10-11T11:00:00Z',
			},
		]);
		onDelete(`${BASE}/comments/c1`, () => ({ success: true }));
		const wrapper = await mountDetail();
		await wrapper.get('button[aria-label^="Delete comment"]').trigger('click');
		await flushPromises();
		expect(confirmState.current?.tone).toBe('danger');
		settleConfirm(false);
		await flushPromises();
		expect(mockApi.calls.some((c) => c.method === 'delete')).toBe(false);

		await wrapper.get('button[aria-label^="Delete comment"]').trigger('click');
		await flushPromises();
		settleConfirm(true);
		await flushPromises();
		expect(
			mockApi.calls.some((c) => c.method === 'delete' && c.url === `${BASE}/comments/c1`),
		).toBe(true);
		wrapper.unmount();
	});
});

describe('attachment list', () => {
	it('keeps the list visible when a download fails', async () => {
		onGet('/api/projects/demo/events/evt-1/attachments', () => ({
			attachments: [
				{ id: 'att-1', filename: 'console.log.gz', contentType: 'application/gzip', size: 18432 },
			],
		}));
		const wrapper = mount(AttachmentList, { props: { slug: 'demo', eventId: 'evt-1' } });
		await flushPromises();
		expect(wrapper.text()).toContain('console.log.gz');
		expect(wrapper.text()).toContain('GZIP → auto-decompressed');

		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Download'))
			?.trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('console.log.gz');
		expect(useToast().toasts.at(-1)?.message).toBe('Download failed: network down');
	});

	it('exports the issue as JSON: copy for an AI, or download', async () => {
		mockIssue([
			{
				id: 'a1',
				issueId: 'issue-1',
				userId: 'u',
				userName: 'Ana',
				type: 'comment',
				data: { body: 'looking' },
				createdAt: '2026-10-11T11:00:00Z',
			},
		]);
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const wrapper = await mountDetail();

		const openExport = async () => {
			await wrapper.get('[data-testid="issue-export"]').trigger('click');
			await flushPromises();
		};
		const pick = (label: string) =>
			[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
				b.textContent?.includes(label),
			);

		await openExport();
		pick('Copy as JSON')?.click();
		await flushPromises();
		expect(writeText).toHaveBeenCalledTimes(1);
		const copied = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]);
		expect(copied.format).toBe('sentinel.issue-export/v1');
		expect(copied.issue).toMatchObject({
			id: 'issue-1',
			count: 1284,
			culprit: 'app.js in chargeOrder',
		});
		expect(copied.event.exception.values[0].stacktrace.frames[1]).toMatchObject({
			function: 'chargeOrder',
			context_line: 'charge(order.id);',
		});
		expect(copied.event.environment).toBe('production');
		expect(copied.activity[0]).toMatchObject({ by: 'Ana', data: { body: 'looking' } });
		expect(useToast().toasts.at(-1)?.message).toContain('copied as JSON');

		const createObjectURL = vi.fn(() => 'blob:x');
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		const clicked: string[] = [];
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			clicked.push(this.download);
		});
		await openExport();
		pick('Download .json')?.click();
		await flushPromises();
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(clicked).toEqual(['sentinel-demo-issue-1.json']);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
		click.mockRestore();
		wrapper.unmount();
	});
});
