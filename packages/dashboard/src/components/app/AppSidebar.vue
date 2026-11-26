<script setup lang="ts">
import {
	Bug,
	ChevronsUpDown,
	Filter,
	Folder,
	FolderKanban,
	History,
	LayoutDashboard,
	Package,
	Plug,
	Settings,
	ShieldCheck,
	Users,
} from 'lucide-vue-next';
import { type Component, computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';
import UiMenu, { type MenuItem } from '../ui/UiMenu.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import AppUserMenu from './AppUserMenu.vue';

const emit = defineEmits<{ navigate: [] }>();

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const projectsStore = useProjectsStore();

const currentSlug = computed(() => route.params.slug as string | undefined);
const currentProject = computed(() =>
	projectsStore.projects.find((p) => p.slug === currentSlug.value),
);

interface NavLink {
	to: string;
	label: string;
	icon: Component;
	active: boolean;
	testId?: string;
}

const projectNav = computed<NavLink[]>(() => {
	const p = currentProject.value;
	if (!p) return [];
	const base = `/projects/${p.slug}`;
	const name = String(route.name ?? '');
	return [
		{
			to: `${base}/overview`,
			label: 'Overview',
			icon: LayoutDashboard,
			active: name === 'project-overview',
		},
		{
			to: `${base}/issues`,
			label: 'Issues',
			icon: Bug,
			active: ['issues', 'issue-detail', 'event-detail'].includes(name),
		},
		{
			to: `${base}/releases`,
			label: 'Releases',
			icon: Package,
			active: ['releases', 'release-detail'].includes(name),
		},
		{ to: `${base}/filters`, label: 'Filters', icon: Filter, active: name === 'project-filters' },
		{
			to: `${base}/integrations`,
			label: 'Integrations',
			icon: Plug,
			active: name === 'project-integrations' || name === 'project-integration',
		},
		{
			to: `${base}/settings`,
			label: 'Settings',
			icon: Settings,
			active: name === 'project-settings',
		},
	];
});

const adminNav = computed<NavLink[]>(() => [
	{ to: '/admin/users', label: 'Users', icon: Users, active: route.name === 'admin-users' },
	{
		to: '/admin/projects',
		label: 'Projects',
		icon: Folder,
		active: route.name === 'admin-projects',
	},
	{
		to: '/admin/settings',
		label: 'Settings',
		icon: ShieldCheck,
		active: route.name === 'admin-settings',
	},
	{ to: '/admin/audit', label: 'Audit', icon: History, active: route.name === 'admin-audit' },
]);

const projectItems = computed<MenuItem<string>[]>(() => [
	...projectsStore.projects.map((p) => ({
		value: p.slug,
		label: p.name,
		description: p.platform,
		checked: p.slug === currentSlug.value,
	})),
	{
		value: '__all__',
		label: 'All projects',
		icon: FolderKanban,
		separator: projectsStore.projects.length > 0,
	},
]);

function onProjectSelect(slug: string) {
	emit('navigate');
	void router.push(slug === '__all__' ? '/projects' : `/projects/${slug}/overview`);
}

const connectActive = computed(() => route.name === 'connect');
const initial = (name?: string) => (name?.trim().charAt(0) || '?').toUpperCase();
</script>

<template>
	<aside class="flex h-full w-full flex-col gap-5 border-r border-border bg-sidebar px-3 pt-4 pb-3">
		<RouterLink to="/" class="flex items-center gap-2.5 px-1.5" @click="emit('navigate')">
			<span class="flex size-[26px] items-center justify-center rounded-[7px] bg-accent text-heading-s text-accent-fg">S</span>
			<span class="text-heading-s text-fg">Sentinel</span>
		</RouterLink>

		<div class="flex flex-col gap-2">
			<!-- Project switcher -->
			<UiMenu label="Switch project" :items="projectItems" align="stretch" :width="216" @select="onProjectSelect">
				<template #trigger="{ props: triggerProps }">
					<button
						v-bind="triggerProps"
						type="button"
						class="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-raised p-2 text-left transition-colors hover:border-border-strong"
						data-testid="project-switcher"
					>
						<span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-level-info-bg text-caption font-medium text-level-info">
							{{ currentProject ? initial(currentProject.name) : '∗' }}
						</span>
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-body-s font-medium text-fg">{{ currentProject?.name ?? 'All projects' }}</span>
							<span class="truncate text-caption text-fg-subtle">
								{{ currentProject ? currentProject.platform : `${projectsStore.projects.length} projects` }}
							</span>
						</span>
						<ChevronsUpDown :size="16" class="shrink-0 text-fg-subtle" aria-hidden="true" />
					</button>
				</template>
			</UiMenu>

			<!-- Always-visible shortcut: SDK and MCP setup -->
			<RouterLink
				to="/setup"
				class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors"
				:class="connectActive ? 'border-accent bg-accent-subtle' : 'border-transparent bg-accent-subtle hover:border-accent/50'"
				:aria-current="connectActive ? 'page' : undefined"
				data-testid="connect-shortcut"
				@click="emit('navigate')"
			>
				<Plug :size="16" class="shrink-0 text-accent-text" aria-hidden="true" />
				<span class="flex min-w-0 flex-col">
					<span class="text-body-s font-medium text-fg">Connect</span>
					<span class="truncate text-caption text-accent-text">SDKs &amp; MCP for AI agents</span>
				</span>
			</RouterLink>
		</div>

		<nav aria-label="Main" class="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
			<section v-if="currentProject" aria-labelledby="nav-project">
				<h2 id="nav-project" class="mb-1.5 px-1 text-overline text-fg-subtle uppercase">Project</h2>
				<ul class="flex flex-col gap-0.5">
					<li v-for="item in projectNav" :key="item.to">
						<RouterLink
							:to="item.to"
							class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-body-s font-medium transition-colors"
							:class="item.active ? 'bg-subtle text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg'"
							:aria-current="item.active ? 'page' : undefined"
							@click="emit('navigate')"
						>
							<component :is="item.icon" :size="16" :class="item.active ? 'text-accent-text' : 'text-fg-subtle'" aria-hidden="true" />
							{{ item.label }}
						</RouterLink>
					</li>
				</ul>
			</section>

			<section v-else aria-labelledby="nav-projects">
				<h2 id="nav-projects" class="mb-1.5 px-1 text-overline text-fg-subtle uppercase">Projects</h2>
				<UiSkeleton v-if="projectsStore.loading" variant="line" :count="3" label="Loading projects" class="px-2.5 pt-1" />
				<ul v-else-if="projectsStore.projects.length" class="flex flex-col gap-0.5">
					<li v-for="project in projectsStore.projects" :key="project.id">
						<RouterLink
							:to="`/projects/${project.slug}/overview`"
							class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-body-s font-medium text-fg-muted transition-colors hover:bg-subtle hover:text-fg"
							@click="emit('navigate')"
						>
							<FolderKanban :size="16" class="text-fg-subtle" aria-hidden="true" />
							<span class="truncate">{{ project.name }}</span>
						</RouterLink>
					</li>
				</ul>
				<p v-else class="px-2.5 py-2 text-caption text-fg-subtle">
					No projects yet. An administrator can create one for you.
				</p>
			</section>

			<!-- Administration (passkey-signed-in admins only; project creation and membership live here) -->
			<section v-if="authStore.canUseAdmin" aria-labelledby="nav-admin" data-testid="admin-nav">
				<h2 id="nav-admin" class="mb-1.5 px-1 text-overline text-fg-subtle uppercase">Administration</h2>
				<ul class="flex flex-col gap-0.5">
					<li v-for="item in adminNav" :key="item.to">
						<RouterLink
							:to="item.to"
							class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-body-s font-medium transition-colors"
							:class="item.active ? 'bg-subtle text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg'"
							:aria-current="item.active ? 'page' : undefined"
							@click="emit('navigate')"
						>
							<component :is="item.icon" :size="16" :class="item.active ? 'text-accent-text' : 'text-fg-subtle'" aria-hidden="true" />
							{{ item.label }}
						</RouterLink>
					</li>
				</ul>
			</section>
		</nav>

		<div class="border-t border-border pt-2">
			<AppUserMenu @navigate="emit('navigate')" />
		</div>
	</aside>
</template>
