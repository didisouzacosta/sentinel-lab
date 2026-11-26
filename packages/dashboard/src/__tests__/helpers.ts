import { createPinia, type Pinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { type User, useAuthStore } from '../stores/auth';
import { onPost } from './mocks';

export interface SeededAuth {
	store: ReturnType<typeof useAuthStore>;
	pinia: Pinia;
}

/** Fresh pinia + auth store seeded as an authenticated session. */
export function seedAuth(
	options: {
		hasPasskey?: boolean;
		authenticated?: boolean;
		role?: 'admin' | 'member';
		sessionAuthMethod?: 'password' | 'passkey' | null;
		mustChangePassword?: boolean;
	} = {},
): SeededAuth {
	const pinia = createPinia();
	setActivePinia(pinia);
	const store = useAuthStore();
	if (options.authenticated !== false) {
		const user: User = {
			id: 'user-1',
			email: 'dev@example.com',
			name: 'Dev User',
			role: options.role ?? 'member',
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		};
		store.user = user;
		store.token = 'session-token';
		localStorage.setItem('token', 'session-token');
	}
	store.hasPasskey = options.hasPasskey ?? false;
	store.sessionAuthMethod = options.sessionAuthMethod ?? 'password';
	store.mustChangePassword = options.mustChangePassword ?? false;
	return { store, pinia };
}

/** Minimal memory router covering the routes the views link to. */
export function testRouter(): Router {
	return createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/login', component: { template: '<div>login</div>' } },
			{ path: '/settings', name: 'settings', component: { template: '<div>settings</div>' } },
			{
				path: '/settings/tokens',
				name: 'api-tokens',
				component: { template: '<div>tokens</div>' },
			},
			{ path: '/setup', name: 'connect', component: { template: '<div>connect</div>' } },
			{ path: '/projects', name: 'projects', component: { template: '<div>projects</div>' } },
			{
				path: '/projects/:slug/overview',
				name: 'project-overview',
				component: { template: '<div>overview</div>' },
			},
			{
				path: '/projects/:slug/issues',
				name: 'issues',
				component: { template: '<div>issues</div>' },
			},
			{ path: '/admin/users', component: { template: '<div>admin users</div>' } },
			{ path: '/admin/projects', component: { template: '<div>admin projects</div>' } },
			{ path: '/admin/settings', component: { template: '<div>admin settings</div>' } },
			{ path: '/admin/audit', component: { template: '<div>admin audit</div>' } },
			{
				path: '/projects/:slug/settings',
				component: { template: '<div>project settings</div>' },
			},
			{
				path: '/projects/:slug/integrations',
				name: 'project-integrations',
				component: { template: '<div>integrations</div>' },
			},
			{
				path: '/projects/:slug/integrations/:kind',
				name: 'project-integration',
				component: { template: '<div>integration</div>' },
			},
			{ path: '/', component: { template: '<div>home</div>' } },
		],
	});
}

export async function atRoute(router: Router, path: string): Promise<void> {
	await router.push(path);
	await router.isReady();
}

/** Standard ceremony mocks for registerPasskey/loginWithPasskey flows. */
export function mockPasskeyCeremony(): void {
	onPost('/api/auth/webauthn/register/options', () => ({ options: {}, ceremonyId: 'cer-reg-1' }));
	onPost('/api/auth/webauthn/verify/register', () => ({
		credential: {
			id: 'cred-1',
			name: 'Test Key',
			createdAt: '2026-01-01T00:00:00Z',
			lastUsedAt: null,
		},
	}));
	onPost('/api/auth/webauthn/login/options', () => ({ options: {}, ceremonyId: 'cer-login-1' }));
	onPost('/api/auth/webauthn/verify/login', () => ({
		user: {
			id: 'user-1',
			email: 'dev@example.com',
			name: 'Dev User',
			role: 'member',
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		},
		token: 'fresh-session-token',
		hasPasskey: true,
	}));
}
