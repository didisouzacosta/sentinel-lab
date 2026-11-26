<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AppSidebar from '../components/app/AppSidebar.vue';
import AppTopBar, { type Crumb } from '../components/app/AppTopBar.vue';
import ForcePasswordChange from '../components/ForcePasswordChange.vue';
import PasskeyNag from '../components/PasskeyNag.vue';
import UiDrawer from '../components/ui/UiDrawer.vue';
import { useAuthStore } from '../stores/auth';
import { useProjectsStore } from '../stores/projects';

const route = useRoute();
const authStore = useAuthStore();
const projectsStore = useProjectsStore();

const navOpen = ref(false);

const currentProject = computed(() =>
	projectsStore.projects.find((p) => p.slug === route.params.slug),
);

const PAGE: Record<string, string> = {
	'project-overview': 'Overview',
	issues: 'Issues',
	'issue-detail': 'Issue',
	'event-detail': 'Event',
	releases: 'Releases',
	'release-detail': 'Release',
	'project-filters': 'Filters',
	'project-integrations': 'Integrations',
	'project-integration': 'Integrations',
	'project-settings': 'Settings',
};

const INTEGRATION_NAMES: Record<string, string> = {
	slack: 'Slack',
	kaneo: 'Kaneo',
	webhook: 'Webhook',
};

const crumbs = computed<Crumb[]>(() => {
	const name = String(route.name ?? '');
	const p = currentProject.value;
	if (p && PAGE[name]) {
		const base = `/projects/${p.slug}`;
		const list: Crumb[] = [{ label: p.name, to: `${base}/overview` }];
		if (name === 'issue-detail' || name === 'event-detail')
			list.push({ label: 'Issues', to: `${base}/issues` });
		if (name === 'release-detail') list.push({ label: 'Releases', to: `${base}/releases` });
		if (name === 'project-integration') {
			list.push({ label: 'Integrations', to: `${base}/integrations` });
			list.push({ label: INTEGRATION_NAMES[String(route.params.kind)] ?? 'Integration' });
			return list;
		}
		list.push({ label: name === 'release-detail' ? String(route.params.version) : PAGE[name] });
		return list;
	}
	if (name.startsWith('admin-')) {
		const label = {
			'admin-users': 'Users',
			'admin-projects': 'Projects',
			'admin-settings': 'Settings',
			'admin-audit': 'Audit',
		}[name];
		return [{ label: 'Administration' }, { label: label ?? 'Administration' }];
	}
	if (name === 'settings') return [{ label: 'Account' }, { label: 'Settings' }];
	if (name === 'api-tokens')
		return [{ label: 'Account', to: '/settings' }, { label: 'API tokens' }];
	if (name === 'connect') return [{ label: 'Sentinel', to: '/projects' }, { label: 'Connect' }];
	return [{ label: 'Sentinel' }, { label: 'Projects' }];
});

// Tab title follows the page: "Issues · web-frontend · Sentinel"
watch(
	crumbs,
	(list) => {
		const parts = [list.at(-1)?.label, currentProject.value?.name, 'Sentinel'].filter(Boolean);
		document.title = [...new Set(parts)].join(' · ');
	},
	{ immediate: true },
);

// Navigating closes the mobile drawer
watch(
	() => route.fullPath,
	() => {
		navOpen.value = false;
	},
);

watch(
	() => authStore.isAuthenticated,
	(isAuth) => {
		if (isAuth && !projectsStore.initialized) {
			projectsStore.loadProjects();
		}
	},
	{ immediate: true },
);
</script>

<template>
	<!-- Blocking forced-password-change screen: replaces all app content until the
	     temp password is replaced (the server enforces the same policy on every route) -->
	<ForcePasswordChange v-if="authStore.mustChangePassword" />
	<div v-else class="flex min-h-dvh bg-canvas text-fg">
		<a
			href="#main"
			class="sr-only rounded-md bg-accent px-3 py-2 text-body-s font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
		>
			Skip to content
		</a>

		<!-- Persistent passkey adoption prompt (per-visit dismissal, in-memory only) -->
		<PasskeyNag />

		<!-- Desktop sidebar -->
		<div class="sticky top-0 hidden h-dvh w-60 shrink-0 lg:block">
			<AppSidebar />
		</div>

		<!-- Mobile/tablet drawer -->
		<UiDrawer v-model:open="navOpen" label="Navigation">
			<AppSidebar v-if="navOpen" @navigate="navOpen = false" />
		</UiDrawer>

		<div class="flex min-w-0 flex-1 flex-col">
			<AppTopBar :crumbs="crumbs" @open-menu="navOpen = true" />
			<main id="main" tabindex="-1" class="min-w-0 flex-1 p-4 outline-none sm:p-6">
				<!-- Centered content column (Figma: 1152px at 1440); narrower pages center inside it -->
				<div class="mx-auto w-full max-w-6xl">
					<RouterView />
				</div>
			</main>
		</div>
	</div>
</template>
