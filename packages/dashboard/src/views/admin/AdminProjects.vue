<script setup lang="ts">
import {
	Ellipsis,
	FolderKanban,
	Pencil,
	Plus,
	Search,
	Trash2,
	UserCog,
	Users,
	X,
} from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import AppPageHeader from '../../components/app/AppPageHeader.vue';
import {
	UiAlert,
	UiAvatar,
	UiButton,
	UiCard,
	UiCopyField,
	UiDialog,
	UiEmptyState,
	UiFormField,
	UiInput,
	UiMenu,
	UiSelect,
	UiSkeleton,
	UiTag,
} from '../../components/ui';
import type { MenuItem } from '../../components/ui/UiMenu.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { useProjectsStore } from '../../stores/projects';

interface AdminUser {
	id: string;
	email: string;
	name: string;
}

interface ProjectOwner {
	userId: string;
	email: string;
	name: string;
}

interface AdminProject {
	id: string;
	name: string;
	slug: string;
	platform: string;
	publicKey: string;
	createdAt: string;
	owner: ProjectOwner | null;
	memberCount: number;
}

interface ProjectMember {
	userId: string;
	email: string;
	name: string;
	role: 'owner' | 'admin' | 'member';
}

type Action = 'members' | 'rename' | 'owner' | 'delete';

const toast = useToast();
const askConfirm = useConfirm();

const PLATFORMS = ['javascript', 'node', 'python', 'ruby', 'go', 'cocoa', 'android'];

const projects = ref<AdminProject[]>([]);
const query = ref('');
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Create modal
const showCreate = ref(false);
const createForm = ref({ name: '', platform: 'javascript', ownerId: '' });
const creating = ref(false);
const createError = ref<string | null>(null);
const createdDsn = ref<string | null>(null);

// Rename modal
const renaming = ref<AdminProject | null>(null);
const renameName = ref('');
const renamingBusy = ref(false);
const renameError = ref<string | null>(null);

// Reassign owner modal
const reassigning = ref<AdminProject | null>(null);
const reassignOwnerId = ref('');
const reassignBusy = ref(false);
const reassignError = ref<string | null>(null);

// Members drawer
const membersProject = ref<AdminProject | null>(null);
const members = ref<ProjectMember[]>([]);
const membersLoading = ref(false);
const membersError = ref<string | null>(null);
const newMemberEmail = ref('');
const newMemberRole = ref<'admin' | 'member'>('member');
const addingMember = ref(false);

// Delete confirm (type the project name)
const deleting = ref<AdminProject | null>(null);
const deleteConfirmName = ref('');
const deletingBusy = ref(false);
const deleteError = ref<string | null>(null);

/** v-model:open for dialogs whose open state is "a project is selected". */
function openWhile<T>(target: { value: T | null }) {
	return computed({
		get: () => target.value !== null,
		set: (open: boolean) => {
			if (!open) target.value = null;
		},
	});
}
const renameOpen = openWhile(renaming);
const reassignOpen = openWhile(reassigning);
const membersOpen = openWhile(membersProject);
const deleteOpen = openWhile(deleting);

const filtered = computed(() => {
	const q = query.value.trim().toLowerCase();
	return q
		? projects.value.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q))
		: projects.value;
});

const ACTIONS: MenuItem<Action>[] = [
	{ value: 'members', label: 'Members', icon: Users },
	{ value: 'rename', label: 'Rename', icon: Pencil },
	{ value: 'owner', label: 'Reassign owner', icon: UserCog },
	{ value: 'delete', label: 'Delete project', icon: Trash2, danger: true, separator: true },
];

function onAction(project: AdminProject, action: Action) {
	if (action === 'members') openMembers(project);
	else if (action === 'rename') openRename(project);
	else if (action === 'owner') openReassign(project);
	else openDelete(project);
}

async function load() {
	loading.value = true;
	error.value = null;
	try {
		const [projectsResponse, usersResponse] = await Promise.all([
			api.get<{ projects: AdminProject[] }>('/api/admin/projects'),
			api.get<{ users: AdminUser[] }>('/api/admin/users'),
		]);
		projects.value = projectsResponse.projects;
		users.value = usersResponse.users;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load projects';
	} finally {
		loading.value = false;
	}
}

const projectsStore = useProjectsStore();

/**
 * Refresh the admin list and the sidebar nav's project list together.
 * Every mutation here can change the signed-in user's accessible
 * projects (create with self as owner, rename, delete, owner/member
 * changes touching the acting admin), and the left-hand nav reads the
 * shared projects store — which otherwise stays stale after its initial
 * load until a full page reload.
 */
async function refreshLists() {
	await Promise.all([load(), projectsStore.loadProjects()]);
}

onMounted(load);

function openCreate() {
	createForm.value = { name: '', platform: 'javascript', ownerId: '' };
	createError.value = null;
	createdDsn.value = null;
	showCreate.value = true;
}

async function createProject() {
	createError.value = null;
	if (!createForm.value.ownerId) {
		createError.value = 'Choose an owner';
		return;
	}
	creating.value = true;
	try {
		const response = await api.post<{ dsn: string }>('/api/admin/projects', {
			name: createForm.value.name,
			platform: createForm.value.platform,
			ownerId: createForm.value.ownerId,
		});
		createdDsn.value = response.dsn;
		await refreshLists();
	} catch (err) {
		createError.value = err instanceof Error ? err.message : 'Failed to create project';
	} finally {
		creating.value = false;
	}
}

function openRename(project: AdminProject) {
	renaming.value = project;
	renameName.value = project.name;
	renameError.value = null;
}

async function renameProject() {
	if (!renaming.value) return;
	renamingBusy.value = true;
	renameError.value = null;
	try {
		await api.patch(`/api/admin/projects/${renaming.value.id}`, {
			name: renameName.value,
		});
		renaming.value = null;
		toast.success('Project renamed');
		await refreshLists();
	} catch (err) {
		renameError.value = err instanceof Error ? err.message : 'Failed to rename project';
	} finally {
		renamingBusy.value = false;
	}
}

function openReassign(project: AdminProject) {
	reassigning.value = project;
	reassignOwnerId.value = project.owner?.userId ?? '';
	reassignError.value = null;
}

async function reassignOwner() {
	if (!reassigning.value) return;
	reassignBusy.value = true;
	reassignError.value = null;
	try {
		await api.post(`/api/admin/projects/${reassigning.value.id}/owner`, {
			userId: reassignOwnerId.value,
		});
		reassigning.value = null;
		toast.success('Owner reassigned');
		await refreshLists();
	} catch (err) {
		reassignError.value = err instanceof Error ? err.message : 'Failed to reassign owner';
	} finally {
		reassignBusy.value = false;
	}
}

async function openMembers(project: AdminProject) {
	membersProject.value = project;
	members.value = [];
	membersError.value = null;
	newMemberEmail.value = '';
	newMemberRole.value = 'member';
	await loadMembers();
}

async function loadMembers() {
	if (!membersProject.value) return;
	membersLoading.value = true;
	membersError.value = null;
	try {
		const response = await api.get<{ members: ProjectMember[] }>(
			`/api/admin/projects/${membersProject.value.id}/members`,
		);
		members.value = response.members;
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to load members';
	} finally {
		membersLoading.value = false;
	}
}

async function addMember() {
	if (!membersProject.value || !newMemberEmail.value) return;
	addingMember.value = true;
	membersError.value = null;
	try {
		await api.post(`/api/admin/projects/${membersProject.value.id}/members`, {
			email: newMemberEmail.value,
			role: newMemberRole.value,
		});
		newMemberEmail.value = '';
		newMemberRole.value = 'member';
		await loadMembers();
		await refreshLists();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to add member';
	} finally {
		addingMember.value = false;
	}
}

async function changeMemberRole(member: ProjectMember, role: string) {
	if (!membersProject.value) return;
	membersError.value = null;
	try {
		await api.patch(`/api/admin/projects/${membersProject.value.id}/members/${member.userId}`, {
			role,
		});
		await loadMembers();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to change role';
	}
}

async function removeMember(member: ProjectMember) {
	if (!membersProject.value) return;
	const ok = await askConfirm({
		title: `Remove ${member.name}?`,
		description: `${member.email} loses access to ${membersProject.value.name}.`,
		confirmLabel: 'Remove member',
		tone: 'danger',
	});
	if (!ok || !membersProject.value) return;
	membersError.value = null;
	try {
		await api.delete(`/api/admin/projects/${membersProject.value.id}/members/${member.userId}`);
		await loadMembers();
		await refreshLists();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to remove member';
	}
}

function openDelete(project: AdminProject) {
	deleting.value = project;
	deleteConfirmName.value = '';
	deleteError.value = null;
}

async function deleteProject() {
	if (!deleting.value) return;
	deletingBusy.value = true;
	deleteError.value = null;
	try {
		await api.delete(`/api/admin/projects/${deleting.value.id}`);
		toast.success(`Project "${deleting.value.name}" deleted`);
		deleting.value = null;
		await refreshLists();
	} catch (err) {
		deleteError.value = err instanceof Error ? err.message : 'Failed to delete project';
	} finally {
		deletingBusy.value = false;
	}
}

function formatDate(value: string): string {
	return new Date(value).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}
</script>

<template>
	<div class="flex flex-col gap-5">
		<AppPageHeader
			title="Projects"
			:subtitle="loading ? undefined : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`"
		>
			<template #actions>
				<UiButton variant="primary" :icon="Plus" data-testid="admin-projects-create" @click="openCreate">
					Create project
				</UiButton>
			</template>
		</AppPageHeader>

		<UiInput
			v-model="query"
			:icon="Search"
			type="search"
			placeholder="Filter by name or slug"
			aria-label="Filter by name or slug"
			class="w-full sm:w-80"
		/>

		<UiSkeleton v-if="loading" :count="4" label="Loading projects" />

		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="load">
			{{ error }}
		</UiAlert>

		<UiCard v-else>
			<table class="w-full border-collapse text-left max-sm:block sm:table-fixed" data-testid="admin-projects-table">
				<caption class="sr-only">Projects</caption>
				<thead class="max-sm:sr-only">
					<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
						<th scope="col" class="py-2 pl-4 font-semibold">Name</th>
						<th scope="col" class="w-44 py-2 pr-4 font-semibold max-md:hidden">Slug</th>
						<th scope="col" class="py-2 pr-4 font-semibold max-lg:hidden">Owner</th>
						<th scope="col" class="w-24 py-2 pr-4 font-semibold">Members</th>
						<th scope="col" class="w-32 py-2 pr-4 font-semibold max-xl:hidden">Created</th>
						<th scope="col" class="w-14 py-2 pr-4"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="max-sm:block">
					<tr
						v-for="project in filtered"
						:key="project.id"
						class="relative border-b border-border last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:py-3 max-sm:pr-14 max-sm:pl-4"
						:data-testid="`admin-project-row-${project.slug}`"
					>
						<td class="min-w-0 py-2.5 pl-4 max-sm:basis-full max-sm:p-0">
							<p class="truncate text-body-s font-medium text-fg">{{ project.name }}</p>
							<p class="truncate text-caption text-fg-subtle">
								{{ project.platform }}<span class="lg:hidden"> · {{ project.owner ? project.owner.email : 'no owner' }}</span>
							</p>
						</td>
						<td class="py-2.5 pr-4 max-md:hidden">
							<UiTag>{{ project.slug }}</UiTag>
						</td>
						<td class="truncate py-2.5 pr-4 text-body-s text-fg-muted max-lg:hidden">
							{{ project.owner ? project.owner.email : '—' }}
						</td>
						<td class="py-2.5 pr-4 text-body-s text-fg-muted max-sm:p-0 max-sm:text-caption" data-numeric>
							{{ project.memberCount }}<span class="sm:hidden"> members</span>
						</td>
						<td class="py-2.5 pr-4 text-body-s text-fg-muted max-xl:hidden" data-numeric>
							{{ formatDate(project.createdAt) }}
						</td>
						<td class="py-2.5 pr-4 text-right max-sm:absolute max-sm:top-2.5 max-sm:right-3 max-sm:p-0">
							<UiMenu
								:label="`Actions for ${project.name}`"
								:title="project.name"
								:items="ACTIONS"
								@select="onAction(project, $event)"
							>
								<template #trigger="{ props: menuProps }">
									<UiButton
										v-bind="menuProps"
										variant="ghost"
										size="icon-sm"
										:icon="Ellipsis"
										:aria-label="`Actions for ${project.name}`"
										:data-testid="`admin-project-actions-${project.slug}`"
									/>
								</template>
							</UiMenu>
						</td>
					</tr>
				</tbody>
			</table>
			<UiEmptyState
				v-if="filtered.length === 0"
				:icon="FolderKanban"
				:title="projects.length ? 'No projects match' : 'No projects yet'"
				:description="projects.length ? 'Try another name or slug.' : 'Create the first project and pick its owner.'"
			/>
		</UiCard>

		<!-- Create (then shows the DSN) -->
		<UiDialog
			v-model:open="showCreate"
			:title="createdDsn ? 'Project created' : 'Create project'"
			:description="createdDsn ? 'Give this DSN to the SDK. It is also on the project settings page.' : 'The owner manages the project; you can add members later.'"
			:form="!createdDsn"
			@submit="createProject"
		>
			<div v-if="createdDsn" class="flex flex-col gap-3">
				<UiCopyField :value="createdDsn" label="DSN" data-testid="admin-created-dsn" />
			</div>
			<div v-else class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="Name" required>
					<UiInput :id="f.id" v-model="createForm.name" required data-testid="admin-project-create-name" />
				</UiFormField>
				<UiFormField v-slot="f" label="Platform">
					<UiSelect :id="f.id" v-model="createForm.platform" class="w-full">
						<option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
					</UiSelect>
				</UiFormField>
				<UiFormField v-slot="f" label="Owner" required>
					<UiSelect :id="f.id" v-model="createForm.ownerId" class="w-full" data-testid="admin-project-create-owner">
						<option value="" disabled>Choose an owner…</option>
						<option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }} ({{ user.email }})</option>
					</UiSelect>
				</UiFormField>
				<UiAlert v-if="createError" tone="error" data-testid="admin-project-create-error">{{ createError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<UiButton v-if="createdDsn" variant="primary" @click="close">Done</UiButton>
				<template v-else>
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						type="submit"
						variant="primary"
						:loading="creating"
						:disabled="!createForm.name || !createForm.ownerId"
						data-testid="admin-project-create-submit"
					>
						Create project
					</UiButton>
				</template>
			</template>
		</UiDialog>

		<!-- Rename -->
		<UiDialog v-model:open="renameOpen" title="Rename project" form @submit="renameProject">
			<div v-if="renaming" class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="Name" :help="`The slug ${renaming.slug} stays the same.`">
					<UiInput
						:id="f.id"
						v-model="renameName"
						:aria-describedby="f.describedBy"
						required
						data-testid="admin-project-rename-input"
					/>
				</UiFormField>
				<UiAlert v-if="renameError" tone="error">{{ renameError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<template v-if="renaming">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						type="submit"
						variant="primary"
						:loading="renamingBusy"
						:disabled="!renameName"
						data-testid="admin-project-rename-submit"
					>
						Save
					</UiButton>
				</template>
			</template>
		</UiDialog>

		<!-- Reassign owner -->
		<UiDialog
			v-model:open="reassignOpen"
			title="Reassign owner"
			:description="reassigning ? `${reassigning.name}: the previous owner stays on as a project admin.` : undefined"
			form
			@submit="reassignOwner"
		>
			<div v-if="reassigning" class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="New owner">
					<UiSelect :id="f.id" v-model="reassignOwnerId" class="w-full" data-testid="admin-project-owner-select">
						<option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }} ({{ user.email }})</option>
					</UiSelect>
				</UiFormField>
				<UiAlert v-if="reassignError" tone="error">{{ reassignError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<template v-if="reassigning">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						type="submit"
						variant="primary"
						:loading="reassignBusy"
						:disabled="!reassignOwnerId"
						data-testid="admin-project-owner-submit"
					>
						Reassign
					</UiButton>
				</template>
			</template>
		</UiDialog>

		<!-- Members -->
		<UiDialog
			v-model:open="membersOpen"
			:title="membersProject ? `Members · ${membersProject.name}` : 'Members'"
			description="The owner is fixed; reassign ownership from the project menu."
			size="lg"
			data-testid="admin-project-members"
		>
			<div v-if="membersProject" class="flex flex-col gap-3">
				<UiAlert v-if="membersError" tone="error">{{ membersError }}</UiAlert>
				<UiSkeleton v-if="membersLoading && members.length === 0" :count="3" label="Loading members" />
				<ul v-else class="overflow-hidden rounded-lg border border-border">
					<li
						v-for="member in members"
						:key="member.userId"
						class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2 last:border-b-0"
					>
						<UiAvatar :name="member.name" size="sm" />
						<div class="min-w-0 flex-1">
							<p class="truncate text-body-s font-medium text-fg">{{ member.name }}</p>
							<p class="truncate text-caption text-fg-subtle">{{ member.email }}</p>
						</div>
						<UiTag v-if="member.role === 'owner'" tone="accent">owner</UiTag>
						<template v-else>
							<UiSelect
								:model-value="member.role"
								:aria-label="`Role of ${member.name}`"
								class="w-28"
								@update:model-value="changeMemberRole(member, String($event))"
							>
								<option value="admin">Admin</option>
								<option value="member">Member</option>
							</UiSelect>
							<UiButton
								variant="ghost"
								size="icon-sm"
								:icon="X"
								:aria-label="`Remove ${member.name}`"
								@click="removeMember(member)"
							/>
						</template>
					</li>
				</ul>
				<form class="flex flex-col gap-2 pt-2" @submit.prevent="addMember">
					<h3 class="text-overline text-fg-subtle uppercase">Add member</h3>
					<div class="flex flex-wrap gap-2">
						<UiInput
							v-model="newMemberEmail"
							type="email"
							placeholder="user@example.com"
							aria-label="Email of the new member"
							class="min-w-48 flex-1"
							data-testid="admin-project-member-email"
						/>
						<UiSelect v-model="newMemberRole" aria-label="Role of the new member" class="w-28">
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</UiSelect>
						<UiButton
							type="submit"
							variant="primary"
							:loading="addingMember"
							:disabled="!newMemberEmail"
							data-testid="admin-project-member-add"
						>
							Add
						</UiButton>
					</div>
				</form>
			</div>
		</UiDialog>

		<!-- Delete: type the project name -->
		<UiDialog v-model:open="deleteOpen" title="Delete project" size="sm" form @submit="deleteProject">
			<div v-if="deleting" class="flex flex-col gap-3">
				<p class="text-body-s text-fg-muted">
					This permanently removes <strong class="text-fg">{{ deleting.name }}</strong> and purges all of its
					events, attachments and statistics.
				</p>
				<label class="flex flex-col gap-1.5 text-body-s text-fg">
					<span>Type <strong class="font-mono">{{ deleting.name }}</strong> to confirm</span>
					<UiInput v-model="deleteConfirmName" autocomplete="off" data-testid="admin-project-delete-confirm" />
				</label>
				<UiAlert v-if="deleteError" tone="error">{{ deleteError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<template v-if="deleting">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						type="submit"
						variant="danger"
						:icon="Trash2"
						:loading="deletingBusy"
						:disabled="deleteConfirmName !== deleting.name"
						data-testid="admin-project-delete-submit"
					>
						Delete project
					</UiButton>
				</template>
			</template>
		</UiDialog>
	</div>
</template>
