import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppDebugFilesSettings from '../components/app/AppDebugFilesSettings.vue';
import AppIssueRow from '../components/app/AppIssueRow.vue';
import AppStackFrame from '../components/app/AppStackFrame.vue';
import { useToast } from '../composables/useToast';
import IssueDetail from '../views/IssueDetail.vue';
import { seedAuth } from './helpers';
import { api, mockApi, onGet, onPost, resetMocks } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);

const DSYM = '50b959c2-7066-33ae-8751-88bd95371d96';
const MAPPING = '11111111-2222-3333-4444-555555555555';

function makeRouter() {
	return createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: '/projects/:slug/settings',
				name: 'project-settings',
				component: { template: '<div />' },
			},
			{
				path: '/projects/:slug/issues/:issueId',
				name: 'issue-detail',
				component: { template: '<div />' },
			},
			{ path: '/projects/:slug/issues', component: { template: '<div />' } },
		],
	});
}

afterEach(() => {
	resetMocks();
	document.body.innerHTML = '';
});

describe('Project settings → Debug files', () => {
	const FILES = [
		{
			id: 'f1',
			debugId: DSYM,
			kind: 'macho',
			arch: 'arm64',
			name: 'CrashDemo',
			size: 9700,
			createdAt: '2026-11-27T00:00:00Z',
		},
		{
			id: 'f2',
			debugId: '76030f1c-2e68-573e-87fc-2b96898fdff3',
			kind: 'proguard',
			arch: null,
			name: 'mapping.txt',
			size: 2400,
			createdAt: '2026-11-26T00:00:00Z',
		},
	];

	async function mountAt(path: string, canManage = true) {
		onGet('/api/projects/demo/debug-files?limit=200', () => ({ debugFiles: FILES }));
		const { pinia } = seedAuth();
		const router = makeRouter();
		await router.push(path);
		await router.isReady();
		const wrapper = mount(AppDebugFilesSettings, {
			props: { slug: 'demo', canManage },
			attachTo: document.body,
			global: { plugins: [pinia, router] },
		});
		await flushPromises();
		return wrapper;
	}

	it('separates iOS dSYMs from Android mappings, each with how to get the file', async () => {
		const wrapper = await mountAt('/projects/demo/settings');
		expect(wrapper.text()).toContain('iOS · dSYMs');
		expect(wrapper.text()).toContain('Android · ProGuard/R8');
		expect(wrapper.text()).toContain('How to get your dSYMs');
		expect(wrapper.findAll('[data-testid="debug-file-row"]')).toHaveLength(1);
		expect(wrapper.text()).toContain(DSYM);
		expect(wrapper.text()).not.toContain('mapping.txt ·');

		await wrapper.findAll('[role="tab"]')[1].trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('How to get your mapping');
		expect(wrapper.text()).toContain('sentry-debug-meta.properties');
		expect(wrapper.findAll('[data-testid="debug-file-row"]')).toHaveLength(1);
		expect(wrapper.text()).toContain('Mapping UUID');
	});

	it('opens the right tab from a crash, names the missing file and pre-fills the mapping UUID', async () => {
		const wrapper = await mountAt(
			`/projects/demo/settings?debugFiles=android&debugId=${MAPPING}&issue=issue-9`,
		);
		const alert = wrapper.get('[data-testid="debug-file-wanted"]');
		expect(alert.text()).toContain(MAPPING);
		expect(alert.text()).toContain('mapping');
		expect((wrapper.get('input[autocomplete="off"]').element as HTMLInputElement).value).toBe(
			MAPPING,
		);
	});

	it('uploads a mapping with its UUID and says which issues are being reprocessed', async () => {
		let sent: { url?: string; body?: unknown } = {};
		onPost(
			`/api/projects/demo/debug-files?kind=proguard&name=mapping.txt&debugId=${MAPPING}`,
			(body) => {
				sent = { body };
				return { debugFiles: [], reprocessing: 3 };
			},
		);
		const wrapper = await mountAt(`/projects/demo/settings?debugFiles=android&debugId=${MAPPING}`);
		const file = new File(['com.example.Foo -> a.a:\n'], 'mapping.txt', { type: 'text/plain' });
		const input = wrapper.get('[data-testid="debug-file-input"]');
		Object.defineProperty(input.element, 'files', { value: [file] });
		await input.trigger('change');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(api.upload).toHaveBeenCalledTimes(1);
		expect(sent.body).toBe(file);
		const toasts = useToast()
			.toasts.map((t) => t.message)
			.join(' ');
		expect(toasts).toContain('Reprocessing 3 issues');
	});

	it('lets only managers delete', async () => {
		const wrapper = await mountAt('/projects/demo/settings', false);
		expect(wrapper.find('[data-testid="debug-file-row"] button').exists()).toBe(false);
	});
});

describe('Native frames', () => {
	it('shows binary and address when nothing could name the frame', () => {
		const wrapper = mount(AppStackFrame, {
			props: {
				frame: {
					instruction_addr: '0x19a000100',
					package: '/usr/lib/system/libdyld.dylib',
					in_app: false,
				},
				showOriginal: false,
				expanded: false,
			},
		});
		expect(wrapper.text()).toContain('libdyld.dylib');
		expect(wrapper.text()).toContain('0x19a000100');
		expect(wrapper.text()).toContain('(no debug file)');
	});

	it('shows function and file:line once symbolicated', () => {
		const wrapper = mount(AppStackFrame, {
			props: {
				frame: {
					instruction_addr: '0x104b2c464',
					function: 'crash_here',
					filename: 'crash.c',
					lineno: 2,
					in_app: true,
				},
				showOriginal: false,
				expanded: false,
			},
		});
		expect(wrapper.text()).toContain('crash.c');
		expect(wrapper.text()).toContain(':2');
		expect(wrapper.text()).toContain('crash_here');
		expect(wrapper.text()).not.toContain('0x104b2c464');
	});
});

describe('JVM frames', () => {
	it('show the class when the frame has no file name', () => {
		const wrapper = mount(AppStackFrame, {
			props: {
				frame: { function: 'run', module: 'android.os.Handler', lineno: 5, in_app: false },
				showOriginal: false,
				expanded: false,
			},
		});
		expect(wrapper.text()).toContain('android.os.Handler');
		expect(wrapper.text()).toContain(':5');
	});
});

describe('Issue with a missing dSYM', () => {
	const nativeEvent = (overrides: Record<string, unknown> = {}) => ({
		event_id: 'evt-1',
		timestamp: '2026-11-27T10:00:00Z',
		level: 'fatal',
		platform: 'cocoa',
		tags: { symbolication: 'missing' },
		exception: {
			values: [
				{
					type: 'EXC_BAD_ACCESS',
					value: 'KERN_INVALID_ADDRESS at 0x0',
					stacktrace: {
						frames: [
							{
								instruction_addr: '0x104b2c464',
								package: '/var/x/CrashDemo.app/CrashDemo',
								in_app: true,
							},
						],
					},
				},
			],
		},
		...overrides,
	});

	async function mountIssue(event: unknown, missing: unknown[]) {
		onGet('/api/projects/demo/issues/issue-1', () => ({
			issue: {
				id: 'issue-1',
				title: 'EXC_BAD_ACCESS',
				culprit: null,
				level: 'fatal',
				platform: 'cocoa',
				firstSeen: '2026-11-27T09:00:00Z',
				lastSeen: '2026-11-27T10:00:00Z',
				count: 1,
				userCount: 1,
				status: 'unresolved',
				snoozedUntil: null,
				metadata: { type: 'EXC_BAD_ACCESS', value: 'KERN_INVALID_ADDRESS at 0x0' },
				missingDebugFiles: missing,
			},
		}));
		onGet('/api/projects/demo/issues/issue-1/events?limit=10', () => ({ events: [event] }));
		onGet('/api/projects/demo/issues/issue-1/activity', () => ({ activity: [] }));
		onPost('/api/projects/demo/debug-files/check', () => ({
			images: [
				{
					debugId: DSYM,
					kind: 'macho',
					codeFile: '/var/x/CrashDemo.app/CrashDemo',
					arch: 'arm64',
					status: 'missing',
					needed: true,
				},
				{
					debugId: 'dddddddd-0000-1111-2222-333333333333',
					kind: 'macho',
					codeFile: '/usr/lib/system/libdyld.dylib',
					arch: 'arm64',
					status: 'missing',
					needed: false,
				},
			],
		}));
		const { pinia } = seedAuth();
		const router = makeRouter();
		await router.push('/projects/demo/issues/issue-1');
		await router.isReady();
		const wrapper = mount(IssueDetail, {
			global: { plugins: [pinia, router], stubs: { AttachmentList: true } },
		});
		await flushPromises();
		return wrapper;
	}

	it('shows a "dSYM missing" tag that links to the iOS upload tab', async () => {
		const wrapper = await mountIssue(nativeEvent(), [
			{ debugId: DSYM, kind: 'macho', image: 'CrashDemo' },
		]);
		const tag = wrapper.get('[data-testid="missing-debug-file"]');
		expect(tag.text()).toContain('dSYM missing');
		const href = tag.attributes('href') ?? '';
		expect(href).toContain('/projects/demo/settings');
		expect(href).toContain('debugFiles=ios');
		expect(href).toContain(`debugId=${DSYM}`);
		expect(href).toContain('issue=issue-1');
		expect(href).toContain('#debug-files');
		expect(wrapper.get('[data-testid="stack-missing-debug-file"]').text()).toContain(
			'the dSYM for CrashDemo',
		);
	});

	it('lists only the app image as needed and counts the system libraries', async () => {
		const wrapper = await mountIssue(nativeEvent(), [
			{ debugId: DSYM, kind: 'macho', image: 'CrashDemo' },
		]);
		const card = wrapper.get('[data-testid="issue-debug-files"]');
		expect(card.text()).toContain('CrashDemo');
		expect(card.text()).toContain('Missing');
		expect(card.text()).toContain('1 system library without debug files');
		expect(card.text()).toContain('Upload dSYM');
		expect(card.text()).not.toContain('libdyld.dylib');
	});

	it('switches between symbolicated and raw frames', async () => {
		const symbolicated = nativeEvent({
			tags: { symbolication: 'done' },
			exception: {
				values: [
					{
						type: 'EXC_BAD_ACCESS',
						value: 'KERN_INVALID_ADDRESS at 0x0',
						stacktrace: {
							frames: [
								{
									instruction_addr: '0x104b2c464',
									function: 'crash_here',
									filename: 'crash.c',
									lineno: 2,
									in_app: true,
								},
							],
						},
						raw_stacktrace: {
							frames: [
								{
									instruction_addr: '0x104b2c464',
									package: '/var/x/CrashDemo.app/CrashDemo',
									in_app: true,
								},
							],
						},
					},
				],
			},
		});
		const wrapper = await mountIssue(symbolicated, []);
		expect(wrapper.text()).toContain('Symbolicated');
		expect(wrapper.text()).toContain('crash_here');
		const raw = wrapper.findAll('button').find((b) => b.text() === 'Raw');
		await raw?.trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('0x104b2c464');
		expect(wrapper.text()).not.toContain('crash_here');
		expect(wrapper.find('[data-testid="missing-debug-file"]').exists()).toBe(false);
	});
});

describe('Issue rows', () => {
	it('carry a "Mapping missing" link next to the issue link', async () => {
		const router = makeRouter();
		await router.push('/projects/demo/issues');
		const wrapper = mount(AppIssueRow, {
			props: {
				slug: 'demo',
				to: '/projects/demo/issues/i2',
				issue: {
					id: 'i2',
					title: 'NullPointerException',
					culprit: null,
					level: 'fatal',
					lastSeen: '2026-11-27T10:00:00Z',
					count: 3,
					userCount: 2,
					metadata: { type: 'NullPointerException', value: 'boom' },
					missingDebugFiles: [{ debugId: MAPPING, kind: 'proguard', image: null }],
				},
			},
			global: { plugins: [router] },
		});
		const links = wrapper.findAll('a');
		expect(links).toHaveLength(2); // issue + tag, siblings (never nested)
		expect(links[1].text()).toContain('Mapping missing');
		expect(links[1].attributes('href')).toContain('debugFiles=android');
		expect(mockApi.calls).toHaveLength(0);
	});
});
