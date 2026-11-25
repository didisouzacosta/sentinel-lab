<script setup lang="ts">
import { FolderKanban } from 'lucide-vue-next';
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import AppProjectCard from '../components/app/AppProjectCard.vue';
import { UiAlert, UiCard, UiEmptyState, UiSkeleton } from '../components/ui';

interface Project {
	id: string;
	name: string;
	slug: string;
	platform: string;
	createdAt: string;
}

const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
	loading.value = true;
	error.value = null;
	try {
		const response = await api.get<{ projects: Project[] }>('/api/projects');
		projects.value = response.projects;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load projects';
	} finally {
		loading.value = false;
	}
}

onMounted(load);
</script>

<template>
	<div class="flex flex-col gap-6">
		<AppPageHeader
			title="Projects"
			:subtitle="
				loading || error
					? undefined
					: `${projects.length} project${projects.length === 1 ? '' : 's'} you are a member of`
			"
		/>

		<div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="projects-loading">
			<UiSkeleton v-for="i in 3" :key="i" variant="block" label="Loading projects" class="h-[122px]" />
		</div>

		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="load">
			{{ error }}
		</UiAlert>

		<UiCard v-else-if="projects.length === 0">
			<UiEmptyState
				:icon="FolderKanban"
				title="No projects"
				description="Project creation is managed by administrators — ask one to create a project for you."
			/>
		</UiCard>

		<ul v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			<li v-for="project in projects" :key="project.id">
				<AppProjectCard
					:name="project.name"
					:slug="project.slug"
					:platform="project.platform"
					:created-at="project.createdAt"
					:to="`/projects/${project.slug}/issues`"
				/>
			</li>
		</ul>
	</div>
</template>
