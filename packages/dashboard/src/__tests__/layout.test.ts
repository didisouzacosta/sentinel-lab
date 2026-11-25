import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import Connect from '../views/Connect.vue';
import Layout from '../views/Layout.vue';
import { atRoute, seedAuth, testRouter } from './helpers';
import { mockApi, onGet, onPost } from './mocks';

vi.mock('../api/client', () =>
	import('./mocks').then((m) => ({ api: m.api, ApiError: m.ApiError })),
);
vi.mock('@simplewebauthn/browser', () =>
	import('./mocks').then((m) => ({
		startRegistration: m.startRegistration,
		startAuthentication: m.startAuthentication,
	})),
);

afterEach(() => {
	document.body.innerHTML = '';
	localStorage.removeItem('sentinel-theme');
});

async function mountLayout(path = '/projects', options: Parameters<typeof seedAuth>[0] = {}) {
	onGet('/api/projects', () => ({
		projects: [{ id: 'p1', name: 'Web Frontend', slug: 'web-frontend', platform: 'javascript' }],
	}));
	const { pinia } = seedAuth({ hasPasskey: true, ...options });
	const router = testRouter();
	await atRoute(router, path);
	const wrapper = mount(Layout, {
		attachTo: document.body,
		global: { plugins: [pinia, router], stubs: { RouterView: true } },
	});
	await flushPromises();
	return { wrapper, router, pinia };
}

async function openUserMenu(wrapper: Awaited<ReturnType<typeof mountLayout>>['wrapper']) {
	await wrapper.get('[data-testid="user-menu-trigger"]').trigger('click');
	await flushPromises();
	return document.querySelector('[role="menu"][aria-label="Account"]') as HTMLElement;
}

function menuItem(menu: HTMLElement, label: string) {
	return [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-item]')].find((b) =>
		b.textContent?.includes(label),
	);
}

describe('sidebar user menu', () => {
	it('shows the signed-in identity on a menu trigger', async () => {
		const { wrapper } = await mountLayout();
		const trigger = wrapper.get('[data-testid="user-menu-trigger"]');
		expect(trigger.text()).toContain('Dev User');
		expect(trigger.text()).toContain('dev@example.com');
		expect(trigger.attributes('aria-haspopup')).toBe('menu');
		wrapper.unmount();
	});

	it('opens account entries and navigates to settings', async () => {
		const { wrapper, router } = await mountLayout();
		const menu = await openUserMenu(wrapper);
		expect(menu.textContent).toContain('member · signed in with password');
		for (const label of [
			'Account settings',
			'Security & passkeys',
			'API tokens',
			'Connect an AI agent (MCP)',
			'Sign out',
		]) {
			expect(menuItem(menu, label), label).toBeTruthy();
		}
		menuItem(menu, 'Account settings')?.click();
		await flushPromises();
		expect(router.currentRoute.value.fullPath).toBe('/settings');

		const again = await openUserMenu(wrapper);
		menuItem(again, 'Connect an AI agent (MCP)')?.click();
		await flushPromises();
		expect(router.currentRoute.value.fullPath).toBe('/setup?tab=mcp');
		wrapper.unmount();
	});

	it('switches the theme from the menu and remembers it', async () => {
		const { wrapper } = await mountLayout();
		const menu = await openUserMenu(wrapper);
		const dark = menuItem(menu, 'Dark');
		expect(dark?.getAttribute('role')).toBe('menuitemradio');
		dark?.click();
		await flushPromises();
		expect(document.documentElement.dataset.theme).toBe('dark');
		expect(localStorage.getItem('sentinel-theme')).toBe('dark');

		const again = await openUserMenu(wrapper);
		expect(menuItem(again, 'Dark')?.getAttribute('aria-checked')).toBe('true');
		wrapper.unmount();
	});

	it('signs out from the menu', async () => {
		onPost('/api/auth/logout', () => ({ success: true }));
		const { wrapper, router, pinia } = await mountLayout();
		const menu = await openUserMenu(wrapper);
		menuItem(menu, 'Sign out')?.click();
		await flushPromises();
		expect(mockApi.calls.some((c) => c.url === '/api/auth/logout')).toBe(true);
		expect(useAuthStore(pinia).isAuthenticated).toBe(false);
		expect(router.currentRoute.value.path).toBe('/login');
		wrapper.unmount();
	});
});

describe('app shell', () => {
	it('keeps the Connect (SDKs & MCP) shortcut visible with or without a project', async () => {
		const outside = await mountLayout('/projects');
		expect(outside.wrapper.get('[data-testid="connect-shortcut"]').attributes('href')).toBe(
			'/setup',
		);
		outside.wrapper.unmount();

		const inside = await mountLayout('/projects/web-frontend/issues');
		expect(inside.wrapper.find('[data-testid="connect-shortcut"]').exists()).toBe(true);
		// Project navigation lives in the sidebar with the current page marked
		const current = inside.wrapper.find('nav[aria-label="Main"] [aria-current="page"]');
		expect(current.text()).toContain('Issues');
		inside.wrapper.unmount();
	});

	it('renders a breadcrumb and a page title for the current route', async () => {
		const { wrapper } = await mountLayout('/projects/web-frontend/issues');
		const crumbs = wrapper.get('nav[aria-label="Breadcrumb"]');
		expect(crumbs.text()).toContain('Web Frontend');
		expect(crumbs.text()).toContain('Issues');
		expect(document.title).toBe('Issues · Web Frontend · Sentinel');
		expect(wrapper.find('a[href="#main"]').text()).toContain('Skip to content');
		wrapper.unmount();
	});

	it('opens the navigation drawer on small screens', async () => {
		const { wrapper } = await mountLayout();
		const dialog = wrapper.get('dialog[aria-label="Navigation"]').element as HTMLDialogElement;
		expect(dialog.open).toBe(false);
		await wrapper.get('[data-testid="open-navigation"]').trigger('click');
		await flushPromises();
		expect(dialog.open).toBe(true);
		expect(dialog.querySelector('[data-testid="connect-shortcut"]')).toBeTruthy();
		wrapper.unmount();
	});
});

describe('Connect page', () => {
	it('shows the project DSN with SDK steps and an MCP tab', async () => {
		onGet('/api/projects', () => ({
			projects: [{ id: 'p1', name: 'Web Frontend', slug: 'web-frontend', platform: 'node' }],
		}));
		onGet('/api/projects/web-frontend', () => ({ dsn: 'https://key@host/p1' }));
		const { pinia } = seedAuth({});
		const router = testRouter();
		await atRoute(router, '/setup');
		const { useProjectsStore } = await import('../stores/projects');
		await useProjectsStore(pinia).loadProjects();
		const wrapper = mount(Connect, { global: { plugins: [pinia, router] } });
		await flushPromises();

		expect(wrapper.get('[data-testid="connect-dsn"]').text()).toContain('https://key@host/p1');
		// Node project → Node.js steps with the DSN filled in
		expect(wrapper.text()).toContain('npm install @sentry/node');
		expect(wrapper.text()).toContain('Sentry.init({ dsn: "https://key@host/p1" })');

		await wrapper.get('[data-testid="connect-tab-mcp"]').trigger('click');
		await flushPromises();
		expect(router.currentRoute.value.query.tab).toBe('mcp');
		// Sentinel's own MCP first: remote HTTP at /mcp with the wst_ token
		const code = wrapper.get('[data-testid="mcp-code"]').text();
		expect(code).toContain('claude mcp add --transport http sentinel');
		expect(code).toContain(`${window.location.origin}/mcp`);
		expect(code).toContain('Authorization: Bearer wst_');
		expect(wrapper.get('[data-testid="mcp-intro"]').text()).toContain('Create projects');
		await wrapper
			.get('[role="radiogroup"][aria-label="MCP client"] [role="radio"]:last-child')
			.trigger('click');
		const json = JSON.parse(wrapper.get('[data-testid="mcp-code"] code').text()) as {
			mcpServers: { sentinel: { type: string; url: string } };
		};
		expect(json.mcpServers.sentinel).toMatchObject({
			type: 'http',
			url: `${window.location.origin}/mcp`,
		});
		// The Sentry MCP server stays documented as the alternative (0.51 reads the
		// instance and token from the environment and runs the `mcp` subcommand)
		const alt = wrapper.get('[data-testid="mcp-sentry-alt"]').text();
		expect(alt).toContain('SENTRY_URL=');
		expect(alt).toContain('SENTRY_AUTH_TOKEN=wst_');
		expect(alt).toContain('@sentry/mcp-server@0.51.0 mcp');
		expect(alt).not.toContain('--access-token');
		const note = wrapper.get('[data-testid="mcp-compat-note"]');
		expect(note.text()).toContain('stack trace');
		expect(note.text()).toContain('Add notes');
	});

	it('has iOS and Android steps and picks them from the project platform', async () => {
		onGet('/api/projects', () => ({
			projects: [
				{ id: 'p1', name: 'iOS App', slug: 'ios-app', platform: 'cocoa' },
				{ id: 'p2', name: 'Android App', slug: 'android-app', platform: 'android' },
			],
		}));
		onGet('/api/projects/ios-app', () => ({ dsn: 'https://key@host/p1' }));
		onGet('/api/projects/android-app', () => ({ dsn: 'https://key@host/p2' }));
		const { pinia } = seedAuth({});
		const router = testRouter();
		await atRoute(router, '/setup');
		const { useProjectsStore } = await import('../stores/projects');
		await useProjectsStore(pinia).loadProjects();
		const wrapper = mount(Connect, { global: { plugins: [pinia, router] } });
		await flushPromises();

		const platforms = wrapper.get<HTMLSelectElement>(
			'select[data-testid="connect-platform-select"]',
		);
		expect(platforms.element.value).toBe('ios');
		expect(wrapper.text()).toContain('https://github.com/didisouzacosta/sentinel-ios');
		expect(wrapper.text()).toContain('Sentinel.start(dsn:');
		expect(wrapper.text()).toContain('Sentinel.grantConsent()');
		expect(wrapper.text()).not.toContain('sentry-cocoa');
		expect(wrapper.text()).toContain('Sentinel.start(dsn: "https://key@host/p1")');

		await router.replace({ query: { project: 'android-app' } });
		await flushPromises();
		expect(platforms.element.value).toBe('android');
		expect(wrapper.text()).toMatch(/io\.sentry:sentry-android:\d+\.\d+\.\d+/);
		expect(wrapper.text()).toContain('android:value="https://key@host/p2"');
	});

	it('covers Workers (Hono), Deno and the SDK-less envelope from the shared catalog', async () => {
		onGet('/api/projects', () => ({
			projects: [{ id: 'p1', name: 'API', slug: 'api', platform: 'cloudflare-workers' }],
		}));
		onGet('/api/projects/api', () => ({ dsn: 'https://key@sentinel.example.com/7' }));
		const { pinia } = seedAuth({});
		const router = testRouter();
		await atRoute(router, '/setup');
		const { useProjectsStore } = await import('../stores/projects');
		await useProjectsStore(pinia).loadProjects();
		const wrapper = mount(Connect, { global: { plugins: [pinia, router] } });
		await flushPromises();

		const platforms = wrapper.get<HTMLSelectElement>(
			'select[data-testid="connect-platform-select"]',
		);
		expect(platforms.element.value).toBe('cloudflare-workers');
		expect(wrapper.text()).toContain('npm install @sentry/cloudflare');
		expect(wrapper.text()).toContain('app.onError');
		expect(wrapper.get('[data-testid="connect-platform-notes"]').text()).toContain('Hono');

		await platforms.setValue('deno');
		expect(wrapper.text()).toContain('npm:@sentry/deno');
		expect(wrapper.text()).toContain('--allow-net=sentinel.example.com');

		await platforms.setValue('envelope');
		expect(wrapper.text()).toContain('const DSN = "https://key@sentinel.example.com/7"');
		expect(wrapper.text()).toContain("connect-src 'self' https://sentinel.example.com");
		expect(wrapper.get('[data-testid="connect-platform-summary"]').text()).toContain(
			'tested with Sentinel',
		);
	});
});
