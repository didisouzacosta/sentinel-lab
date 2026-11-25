<script setup lang="ts">
import {
	Ellipsis,
	Fingerprint,
	KeyRound,
	Pencil,
	Plus,
	Search,
	Trash2,
	Users,
} from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { ApiError, api } from '../../api/client';
import AppPageHeader from '../../components/app/AppPageHeader.vue';
import {
	UiAlert,
	UiAvatar,
	UiButton,
	UiCard,
	UiCheckbox,
	UiDialog,
	UiEmptyState,
	UiFormField,
	UiInput,
	UiMenu,
	UiSegmented,
	UiSelect,
	UiSkeleton,
	UiTag,
} from '../../components/ui';
import type { MenuItem } from '../../components/ui/UiMenu.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { timeAgo } from '../../lib/format';

interface AdminUser {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'member';
	disabled: boolean;
	mustChangePassword: boolean;
	lastLoginAt: string | null;
	passkeyCount: number;
	membershipCount: number;
	createdAt: string;
}

interface OwnedProject {
	id: string;
	name: string;
	slug: string;
}

type Status = 'active' | 'password' | 'disabled';
type Action = 'edit' | 'reset' | 'passkeys' | 'delete';

const toast = useToast();
const askConfirm = useConfirm();

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Filters (client-side: the list is small and already loaded)
const query = ref('');
const roleFilter = ref<'' | 'admin' | 'member'>('');
const statusFilter = ref<'' | Status>('');

// Create
const showCreate = ref(false);
const createForm = ref({ name: '', email: '', password: '', isAdmin: false });
const creating = ref(false);
const createError = ref<string | null>(null);

// Edit
const editing = ref<AdminUser | null>(null);
const editForm = ref({
	name: '',
	email: '',
	role: 'member' as 'admin' | 'member',
	disabled: false,
});
const savingEdit = ref(false);
const editError = ref<string | null>(null);

// Reset password
const resetting = ref<AdminUser | null>(null);
const newPassword = ref('');
const resettingBusy = ref(false);
const resetError = ref<string | null>(null);

// Delete (its own dialog: the server can answer with the projects that block it)
const deleting = ref<AdminUser | null>(null);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);
const deleteBlockedProjects = ref<OwnedProject[] | null>(null);

/** v-model:open for dialogs whose open state is "an item is selected". */
function openWhile<T>(target: { value: T | null }) {
	return computed({
		get: () => target.value !== null,
		set: (open: boolean) => {
			if (!open) target.value = null;
		},
	});
}
const editOpen = openWhile(editing);
const resetOpen = openWhile(resetting);
const deleteOpen = openWhile(deleting);

const STATUS_LABEL: Record<Status, string> = {
	active: 'Active',
	password: 'Password change due',
	disabled: 'Disabled',
};
const STATUS_CLASS: Record<Status, string> = {
	active: 'bg-success-bg text-success',
	password: 'bg-level-warning-bg text-level-warning',
	disabled: 'bg-level-debug-bg text-level-debug',
};
const statusOf = (u: AdminUser): Status =>
	u.disabled ? 'disabled' : u.mustChangePassword ? 'password' : 'active';

const roleOptions = [
	{ value: 'member' as const, label: 'Member' },
	{ value: 'admin' as const, label: 'Admin' },
];

const filtered = computed(() => {
	const q = query.value.trim().toLowerCase();
	return users.value.filter(
		(u) =>
			(!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
			(!roleFilter.value || u.role === roleFilter.value) &&
			(!statusFilter.value || statusOf(u) === statusFilter.value),
	);
});
const summary = computed(() => {
	const admins = users.value.filter((u) => u.role === 'admin').length;
	return `${users.value.length} ${users.value.length === 1 ? 'user' : 'users'} · ${admins} ${admins === 1 ? 'admin' : 'admins'}`;
});

function actionsFor(user: AdminUser): MenuItem<Action>[] {
	return [
		{ value: 'edit', label: 'Edit', icon: Pencil },
		{ value: 'reset', label: 'Reset password', icon: KeyRound },
		{
			value: 'passkeys',
			label: 'Remove passkeys',
			icon: Fingerprint,
			disabled: user.passkeyCount === 0,
		},
		{ value: 'delete', label: 'Delete user', icon: Trash2, danger: true, separator: true },
	];
}

function onAction(user: AdminUser, action: Action) {
	if (action === 'edit') openEdit(user);
	else if (action === 'reset') openReset(user);
	else if (action === 'passkeys') removePasskeys(user);
	else openDelete(user);
}

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

async function loadUsers() {
	loading.value = true;
	error.value = null;
	try {
		const response = await api.get<{ users: AdminUser[] }>('/api/admin/users');
		users.value = response.users;
	} catch (err) {
		error.value = message(err, 'Failed to load users');
	} finally {
		loading.value = false;
	}
}

onMounted(loadUsers);

function openCreate() {
	createForm.value = { name: '', email: '', password: '', isAdmin: false };
	createError.value = null;
	showCreate.value = true;
}

async function createUser() {
	createError.value = null;
	if (createForm.value.password.length < 8) {
		createError.value = 'Temporary password must be at least 8 characters';
		return;
	}
	creating.value = true;
	try {
		await api.post('/api/admin/users', {
			name: createForm.value.name,
			email: createForm.value.email,
			password: createForm.value.password,
			role: createForm.value.isAdmin ? 'admin' : 'member',
		});
		showCreate.value = false;
		toast.success(`User ${createForm.value.email} created`);
		await loadUsers();
	} catch (err) {
		createError.value = message(err, 'Failed to create user');
	} finally {
		creating.value = false;
	}
}

function openEdit(user: AdminUser) {
	editing.value = user;
	editForm.value = { name: user.name, email: user.email, role: user.role, disabled: user.disabled };
	editError.value = null;
}

async function saveEdit() {
	if (!editing.value) return;
	const user = editing.value;
	// Send only the changed fields: an unchanged email must never be
	// re-sent — the admin endpoint pattern-validates emails, so re-sending
	// a stored format-free identifier (self-service profile edits allow
	// them) would reject the whole request and block unrelated edits. The
	// DO applies any subset atomically and treats unchanged fields as
	// no-ops, so a partial send is semantically identical.
	const updates: { name?: string; email?: string; role?: string; disabled?: boolean } = {};
	if (editForm.value.name !== user.name) updates.name = editForm.value.name;
	if (editForm.value.email !== user.email) updates.email = editForm.value.email;
	if (editForm.value.role !== user.role) updates.role = editForm.value.role;
	if (editForm.value.disabled !== user.disabled) updates.disabled = editForm.value.disabled;
	if (Object.keys(updates).length === 0) {
		editing.value = null; // nothing changed — close without a request
		return;
	}
	savingEdit.value = true;
	editError.value = null;
	try {
		await api.patch<{ user: AdminUser }>(`/api/admin/users/${user.id}`, updates);
		editing.value = null;
		toast.success('User updated');
		await loadUsers();
	} catch (err) {
		editError.value = message(err, 'Failed to update user');
	} finally {
		savingEdit.value = false;
	}
}

function openReset(user: AdminUser) {
	resetting.value = user;
	newPassword.value = '';
	resetError.value = null;
}

async function resetPassword() {
	if (!resetting.value) return;
	resetError.value = null;
	if (newPassword.value.length < 8) {
		resetError.value = 'Temporary password must be at least 8 characters';
		return;
	}
	resettingBusy.value = true;
	try {
		await api.post(`/api/admin/users/${resetting.value.id}/reset-password`, {
			newPassword: newPassword.value,
		});
		toast.success(`Password reset for ${resetting.value.email}`);
		resetting.value = null;
		await loadUsers();
	} catch (err) {
		resetError.value = message(err, 'Failed to reset password');
	} finally {
		resettingBusy.value = false;
	}
}

async function removePasskeys(user: AdminUser) {
	const ok = await askConfirm({
		title: 'Remove all passkeys?',
		description: `${user.email} (${user.passkeyCount} ${user.passkeyCount === 1 ? 'passkey' : 'passkeys'}) will fall back to password sign-in.`,
		confirmLabel: 'Remove passkeys',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/admin/users/${user.id}/passkeys`);
		toast.success(`Passkeys removed for ${user.email}`);
		await loadUsers();
	} catch (err) {
		toast.error(message(err, 'Failed to remove passkeys'));
	}
}

function openDelete(user: AdminUser) {
	deleting.value = user;
	deleteError.value = null;
	deleteBlockedProjects.value = null;
}

async function deleteUser() {
	if (!deleting.value) return;
	const email = deleting.value.email;
	deleteBusy.value = true;
	deleteError.value = null;
	deleteBlockedProjects.value = null;
	try {
		await api.delete(`/api/admin/users/${deleting.value.id}`);
		deleting.value = null;
		toast.success(`User ${email} deleted`);
		await loadUsers();
	} catch (err) {
		if (err instanceof ApiError && err.code === 'owns_projects') {
			const projects = err.body?.projects;
			deleteBlockedProjects.value = Array.isArray(projects) ? (projects as OwnedProject[]) : [];
		}
		deleteError.value = message(err, 'Failed to delete user');
	} finally {
		deleteBusy.value = false;
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
		<AppPageHeader title="Users" :subtitle="loading ? undefined : summary">
			<template #actions>
				<UiButton variant="primary" :icon="Plus" data-testid="admin-users-create" @click="openCreate">
					Create user
				</UiButton>
			</template>
		</AppPageHeader>

		<div class="flex flex-wrap gap-2">
			<UiInput
				v-model="query"
				:icon="Search"
				type="search"
				placeholder="Filter by name or email"
				aria-label="Filter by name or email"
				class="w-full sm:w-72"
			/>
			<UiSelect v-model="roleFilter" aria-label="Role" class="max-sm:flex-1">
				<option value="">All roles</option>
				<option value="admin">Admins</option>
				<option value="member">Members</option>
			</UiSelect>
			<UiSelect v-model="statusFilter" aria-label="Status" class="max-sm:flex-1">
				<option value="">All statuses</option>
				<option value="active">Active</option>
				<option value="password">Password change due</option>
				<option value="disabled">Disabled</option>
			</UiSelect>
		</div>

		<UiSkeleton v-if="loading" :count="5" label="Loading users" />

		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadUsers">
			{{ error }}
		</UiAlert>

		<UiCard v-else>
			<table class="w-full border-collapse text-left max-sm:block sm:table-fixed" data-testid="admin-users-table">
				<caption class="sr-only">Users</caption>
				<thead class="max-sm:sr-only">
					<tr class="border-b border-border bg-raised text-overline text-fg-subtle uppercase">
						<th scope="col" class="py-2 pl-4 font-semibold">Name</th>
						<th scope="col" class="py-2 pr-4 font-semibold max-lg:hidden">Email</th>
						<th scope="col" class="w-24 py-2 pr-4 font-semibold">Role</th>
						<th scope="col" class="w-44 py-2 pr-4 font-semibold">Status</th>
						<th scope="col" class="w-24 py-2 pr-4 font-semibold">Passkeys</th>
						<th scope="col" class="w-32 py-2 pr-4 font-semibold max-md:hidden">Last sign-in</th>
						<th scope="col" class="w-32 py-2 pr-4 font-semibold max-xl:hidden">Created</th>
						<th scope="col" class="w-14 py-2 pr-4"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="max-sm:block">
					<tr
						v-for="user in filtered"
						:key="user.id"
						class="relative border-b border-border last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:py-3 max-sm:pr-14 max-sm:pl-4"
						:data-testid="`admin-user-row-${user.email}`"
					>
						<td class="min-w-0 py-2.5 pl-4 max-sm:basis-full max-sm:p-0">
							<div class="flex min-w-0 items-center gap-2.5">
								<UiAvatar :name="user.name" size="sm" />
								<div class="min-w-0">
									<p class="truncate text-body-s font-medium text-fg">{{ user.name }}</p>
									<p class="truncate text-caption text-fg-subtle lg:hidden">{{ user.email }}</p>
								</div>
							</div>
						</td>
						<td class="truncate py-2.5 pr-4 text-body-s text-fg-muted max-lg:hidden">{{ user.email }}</td>
						<td class="py-2.5 pr-4 max-sm:p-0">
							<UiTag :tone="user.role === 'admin' ? 'accent' : 'neutral'">{{ user.role }}</UiTag>
						</td>
						<td class="py-2.5 pr-4 max-sm:p-0">
							<span
								class="inline-flex h-5 items-center rounded-full px-2 text-caption font-medium whitespace-nowrap"
								:class="STATUS_CLASS[statusOf(user)]"
							>
								{{ STATUS_LABEL[statusOf(user)] }}
							</span>
						</td>
						<td class="py-2.5 pr-4 text-body-s text-fg-muted max-sm:p-0 max-sm:text-caption" data-numeric>
							<span class="inline-flex items-center gap-1.5" :aria-label="`${user.passkeyCount} passkeys`">
								<Fingerprint :size="14" class="text-fg-subtle" aria-hidden="true" />
								{{ user.passkeyCount }}
							</span>
						</td>
						<td class="py-2.5 pr-4 text-body-s text-fg-muted max-md:hidden" data-numeric>
							{{ user.lastLoginAt ? timeAgo(user.lastLoginAt) : 'never' }}
						</td>
						<td class="py-2.5 pr-4 text-body-s text-fg-muted max-xl:hidden" data-numeric>
							{{ formatDate(user.createdAt) }}
						</td>
						<td class="py-2.5 pr-4 text-right max-sm:absolute max-sm:top-2.5 max-sm:right-3 max-sm:p-0">
							<UiMenu
								:label="`Actions for ${user.email}`"
								:title="user.name"
								:items="actionsFor(user)"
								@select="onAction(user, $event)"
							>
								<template #trigger="{ props: menuProps }">
									<UiButton
										v-bind="menuProps"
										variant="ghost"
										size="icon-sm"
										:icon="Ellipsis"
										:aria-label="`Actions for ${user.email}`"
										:data-testid="`admin-user-actions-${user.email}`"
									/>
								</template>
							</UiMenu>
						</td>
					</tr>
				</tbody>
			</table>
			<UiEmptyState
				v-if="filtered.length === 0"
				:icon="Users"
				title="No users match"
				description="Try another name, role or status."
			/>
		</UiCard>

		<!-- Create -->
		<UiDialog
			v-model:open="showCreate"
			title="Create user"
			description="They sign in with a temporary password and must change it first."
			form
			@submit="createUser"
		>
			<div class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="Name" required>
					<UiInput :id="f.id" v-model="createForm.name" required data-testid="admin-create-name" />
				</UiFormField>
				<UiFormField v-slot="f" label="Email" required>
					<UiInput :id="f.id" v-model="createForm.email" type="email" required data-testid="admin-create-email" />
				</UiFormField>
				<UiFormField
					v-slot="f"
					label="Temporary password"
					help="At least 8 characters. The user must change it at first sign-in."
					required
				>
					<UiInput
						:id="f.id"
						v-model="createForm.password"
						:aria-describedby="f.describedBy"
						type="text"
						autocomplete="off"
						class="font-mono"
						data-testid="admin-create-password"
					/>
				</UiFormField>
				<UiCheckbox v-model="createForm.isAdmin" label="This is an administrator" data-testid="admin-create-is-admin" />
				<UiAlert v-if="createError" tone="error" data-testid="admin-create-error">{{ createError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<UiButton @click="close">Cancel</UiButton>
				<UiButton
					type="submit"
					variant="primary"
					:loading="creating"
					:disabled="!createForm.name || !createForm.email || !createForm.password"
					data-testid="admin-create-submit"
				>
					Create user
				</UiButton>
			</template>
		</UiDialog>

		<!-- Edit -->
		<UiDialog v-model:open="editOpen" title="Edit user" :description="editing?.email" form @submit="saveEdit">
			<div v-if="editing" class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="Name">
					<UiInput :id="f.id" v-model="editForm.name" data-testid="admin-edit-name" />
				</UiFormField>
				<UiFormField v-slot="f" label="Email">
					<!-- type="text": stored identifiers may be format-free (no "@"), so native email
					     validation would block saving unrelated changes -->
					<UiInput :id="f.id" v-model="editForm.email" type="text" inputmode="email" autocomplete="off" data-testid="admin-edit-email" />
				</UiFormField>
				<div class="flex flex-col gap-1.5">
					<span class="text-body-s font-medium text-fg">Role</span>
					<UiSegmented v-model="editForm.role" label="Role" :options="roleOptions" />
				</div>
				<UiCheckbox
					v-model="editForm.disabled"
					label="Disabled (blocks sign-in, ends sessions)"
					data-testid="admin-edit-disabled"
				/>
				<UiAlert v-if="editError" tone="error" data-testid="admin-edit-error">{{ editError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<template v-if="editing">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton type="submit" variant="primary" :loading="savingEdit" data-testid="admin-edit-submit">
						Save
					</UiButton>
				</template>
			</template>
		</UiDialog>

		<!-- Reset password -->
		<UiDialog
			v-model:open="resetOpen"
			title="Reset password"
			:description="resetting ? `${resetting.email} is signed out everywhere and must change this temporary password at next sign-in.` : undefined"
			form
			@submit="resetPassword"
		>
			<div v-if="resetting" class="flex flex-col gap-4">
				<UiFormField v-slot="f" label="New temporary password" help="At least 8 characters">
					<UiInput
						:id="f.id"
						v-model="newPassword"
						:aria-describedby="f.describedBy"
						type="text"
						autocomplete="off"
						class="font-mono"
						data-testid="admin-reset-password"
					/>
				</UiFormField>
				<UiAlert v-if="resetError" tone="error">{{ resetError }}</UiAlert>
			</div>
			<template #footer="{ close }">
				<template v-if="resetting">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						type="submit"
						variant="primary"
						:loading="resettingBusy"
						:disabled="newPassword.length < 8"
						data-testid="admin-reset-submit"
					>
						Reset password
					</UiButton>
				</template>
			</template>
		</UiDialog>

		<!-- Delete -->
		<UiDialog
			v-model:open="deleteOpen"
			title="Delete user?"
			:description="deleting ? `${deleting.email} — sessions, API tokens, passkeys and project memberships are removed.` : undefined"
			size="sm"
		>
			<div v-if="deleting" class="flex flex-col gap-3">
				<UiAlert v-if="deleteBlockedProjects" tone="warning" data-testid="admin-delete-blocked">
					<p class="font-medium">This user owns projects — reassign or delete these first:</p>
					<ul class="mt-1 list-disc pl-5">
						<li v-for="project in deleteBlockedProjects" :key="project.id">
							{{ project.name }} (<span class="font-mono">{{ project.slug }}</span>)
						</li>
					</ul>
				</UiAlert>
				<UiAlert v-else-if="deleteError" tone="error">{{ deleteError }}</UiAlert>
				<p v-else class="text-body-s text-fg-muted">This cannot be undone.</p>
			</div>
			<template #footer="{ close }">
				<template v-if="deleting">
					<UiButton @click="close">Cancel</UiButton>
					<UiButton
						variant="danger"
						:icon="Trash2"
						:loading="deleteBusy"
						:disabled="!!deleteBlockedProjects"
						data-testid="admin-delete-submit"
						@click="deleteUser"
					>
						Delete user
					</UiButton>
				</template>
			</template>
		</UiDialog>
	</div>
</template>
