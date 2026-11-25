import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client';

export type ProjectRole = 'owner' | 'admin' | 'member';

export interface Project {
	id: string;
	name: string;
	slug: string;
	platform: string;
	/** The signed-in user's role in this project (from GET /api/projects). */
	memberRole?: ProjectRole;
}

export const useProjectsStore = defineStore('projects', () => {
	const projects = ref<Project[]>([]);
	const loading = ref(false);
	const initialized = ref(false);

	async function loadProjects() {
		loading.value = true;
		try {
			const response = await api.get<{ projects: Project[] }>('/api/projects');
			projects.value = response.projects;
			initialized.value = true;
		} catch (err) {
			console.error('Failed to load projects:', err);
		} finally {
			loading.value = false;
		}
	}

	/**
	 * Owners and project admins may delete issues and source maps (and change
	 * security settings). Mirrors the worker's `canManageProject`; the server
	 * enforces it, this only hides controls a member could not use.
	 */
	function canManage(slug: string): boolean {
		const role = projects.value.find((p) => p.slug === slug)?.memberRole;
		return role === 'owner' || role === 'admin';
	}

	function removeProject(slug: string) {
		projects.value = projects.value.filter((p) => p.slug !== slug);
	}

	function reset() {
		projects.value = [];
		initialized.value = false;
	}

	return {
		projects,
		loading,
		initialized,
		loadProjects,
		canManage,
		removeProject,
		reset,
	};
});
