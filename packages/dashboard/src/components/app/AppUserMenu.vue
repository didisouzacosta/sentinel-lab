<script setup lang="ts">
import {
	ChevronsUpDown,
	Fingerprint,
	KeyRound,
	LogOut,
	Monitor,
	Moon,
	ShieldCheck,
	Sparkles,
	Sun,
	UserRound,
} from 'lucide-vue-next';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { type ThemePreference, useTheme } from '../../composables/useTheme';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';
import UiAvatar from '../ui/UiAvatar.vue';
import UiMenu, { type MenuItem } from '../ui/UiMenu.vue';

type Action =
	| 'account'
	| 'security'
	| 'tokens'
	| 'mcp'
	| 'theme:system'
	| 'theme:light'
	| 'theme:dark'
	| 'logout';

const ROUTES: Partial<Record<Action, string>> = {
	account: '/settings',
	security: '/settings?tab=security',
	tokens: '/settings/tokens',
	mcp: '/setup?tab=mcp',
};

const emit = defineEmits<{ navigate: [] }>();

const router = useRouter();
const authStore = useAuthStore();
const projectsStore = useProjectsStore();
const { preference, setTheme } = useTheme();

const items = computed<MenuItem<Action>[]>(() => [
	{ value: 'account', label: 'Account settings', icon: UserRound },
	{ value: 'security', label: 'Security & passkeys', icon: ShieldCheck },
	{ value: 'tokens', label: 'API tokens', icon: KeyRound },
	{ value: 'mcp', label: 'Connect an AI agent (MCP)', icon: Sparkles },
	{
		value: 'theme:system',
		label: 'System',
		icon: Monitor,
		section: 'Theme',
		separator: true,
		checked: preference.value === 'system',
	},
	{ value: 'theme:light', label: 'Light', icon: Sun, checked: preference.value === 'light' },
	{ value: 'theme:dark', label: 'Dark', icon: Moon, checked: preference.value === 'dark' },
	{ value: 'logout', label: 'Sign out', icon: LogOut, danger: true, separator: true },
]);

const sessionLabel = computed(() => {
	const role = authStore.user?.role ?? 'member';
	const method = authStore.sessionAuthMethod === 'passkey' ? 'passkey' : 'password';
	return `${role} · signed in with ${method}`;
});

async function onSelect(action: Action) {
	if (action.startsWith('theme:')) {
		setTheme(action.slice(6) as ThemePreference);
		return;
	}
	if (action === 'logout') {
		await authStore.logout();
		projectsStore.reset();
		await router.push('/login');
		return;
	}
	const target = ROUTES[action];
	if (!target) return;
	emit('navigate');
	await router.push(target);
}
</script>

<template>
	<UiMenu label="Account" :items="items" placement="top" align="stretch" :width="256" @select="onSelect">
		<template #trigger="{ props: triggerProps, open }">
			<button
				v-bind="triggerProps"
				type="button"
				class="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-subtle"
				:class="open ? 'bg-subtle' : ''"
				data-testid="user-menu-trigger"
			>
				<UiAvatar :name="authStore.user?.name" />
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="truncate text-body-s font-medium text-fg">{{ authStore.user?.name }}</span>
					<span class="truncate text-caption text-fg-subtle">{{ authStore.user?.email }}</span>
				</span>
				<ChevronsUpDown :size="16" class="shrink-0 text-fg-subtle" aria-hidden="true" />
			</button>
		</template>
		<template #header>
			<div class="flex items-center gap-2.5">
				<UiAvatar :name="authStore.user?.name" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-body-s font-medium text-fg">{{ authStore.user?.name }}</p>
					<p class="truncate text-caption text-fg-subtle">{{ authStore.user?.email }}</p>
					<p class="mt-0.5 flex items-center gap-1 text-caption text-fg-muted">
						<Fingerprint v-if="authStore.sessionAuthMethod === 'passkey'" :size="12" class="text-accent-text" aria-hidden="true" />
						{{ sessionLabel }}
					</p>
				</div>
			</div>
		</template>
	</UiMenu>
</template>
