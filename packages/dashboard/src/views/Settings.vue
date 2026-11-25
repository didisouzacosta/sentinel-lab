<script setup lang="ts">
import { Fingerprint, KeyRound, Plus, Trash2 } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiFormField,
	UiInput,
	UiSkeleton,
	UiTabs,
	UiTag,
} from '../components/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { type PasskeyCredential, useAuthStore } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const askConfirm = useConfirm();
const toast = useToast();

const tab = computed(() => (route.query.tab === 'security' ? 'security' : 'general'));
const tabModel = computed({
	get: () => tab.value,
	set: (next: 'general' | 'security') => setTab(next),
});
const tabs = [
	{ value: 'general' as const, label: 'General', testId: 'settings-tab-general' },
	{ value: 'security' as const, label: 'Security', testId: 'settings-tab-security' },
];

function setTab(next: 'general' | 'security') {
	router.replace({ query: { ...route.query, tab: next } });
}

// --- Profile (General tab) ---
const profileName = ref(authStore.user?.name ?? '');
const profileEmail = ref(authStore.user?.email ?? '');
const savingProfile = ref(false);
const profileError = ref<string | null>(null);
const profileSuccess = ref(false);

const profileDirty = computed(
	() =>
		profileName.value !== (authStore.user?.name ?? '') ||
		profileEmail.value !== (authStore.user?.email ?? ''),
);

async function saveProfile() {
	if (!profileDirty.value || savingProfile.value) return;
	profileError.value = null;
	profileSuccess.value = false;
	savingProfile.value = true;
	try {
		await authStore.updateProfile(profileName.value, profileEmail.value);
		// Re-sync from the store so the server's normalization (trim,
		// lowercase) is reflected in the inputs
		profileName.value = authStore.user?.name ?? profileName.value;
		profileEmail.value = authStore.user?.email ?? profileEmail.value;
		profileSuccess.value = true;
	} catch (err) {
		profileError.value = err instanceof Error ? err.message : 'Failed to update profile';
	} finally {
		savingProfile.value = false;
	}
}

// A fresh edit invalidates the previous success note
watch(profileDirty, (dirty) => {
	if (dirty) profileSuccess.value = false;
});

// --- Change password ---
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const changingPassword = ref(false);
const passwordError = ref<string | null>(null);

async function changePassword() {
	passwordError.value = null;
	if (!currentPassword.value || !newPassword.value) {
		passwordError.value = 'Fill in all fields';
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		passwordError.value = 'New passwords do not match';
		return;
	}
	if (newPassword.value.length < 8) {
		passwordError.value = 'New password must be at least 8 characters';
		return;
	}
	changingPassword.value = true;
	try {
		// On success the server revokes every session, so this logs out
		await authStore.changePassword(currentPassword.value, newPassword.value);
		router.push('/login');
	} catch (err) {
		passwordError.value = err instanceof Error ? err.message : 'Failed to change password';
	} finally {
		changingPassword.value = false;
	}
}

// --- Passkeys ---
const passkeys = ref<PasskeyCredential[]>([]);
const passkeysLoading = ref(true);
const passkeyError = ref<string | null>(null);
const newPasskeyName = ref('');
const addingPasskey = ref(false);
const deletingPasskeyId = ref<string | null>(null);

const isLastPasskey = computed(() => passkeys.value.length === 1);

async function loadPasskeys() {
	passkeysLoading.value = true;
	passkeyError.value = null;
	try {
		passkeys.value = await authStore.listPasskeys();
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to load passkeys';
	} finally {
		passkeysLoading.value = false;
	}
}

async function addPasskey() {
	const trimmed = newPasskeyName.value.trim();
	if (!trimmed) {
		passkeyError.value = 'Give the passkey a name first';
		return;
	}
	addingPasskey.value = true;
	passkeyError.value = null;
	try {
		await authStore.registerPasskey(trimmed);
		newPasskeyName.value = '';
		await loadPasskeys();
		toast.success(`Passkey "${trimmed}" added`);
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to add passkey';
	} finally {
		addingPasskey.value = false;
	}
}

async function removePasskey(credential: PasskeyCredential) {
	const ok = await askConfirm({
		title: `Delete "${credential.name}"?`,
		description: isLastPasskey.value
			? "This is your last passkey — you'll sign in with your password until you add another."
			: 'You will no longer be able to sign in with this passkey. This cannot be undone.',
		confirmLabel: 'Delete passkey',
		tone: 'danger',
	});
	if (!ok) return;

	deletingPasskeyId.value = credential.id;
	passkeyError.value = null;
	try {
		await authStore.deletePasskey(credential.id);
		await loadPasskeys();
		toast.success(`Passkey "${credential.name}" deleted`);
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to delete passkey';
	} finally {
		deletingPasskeyId.value = null;
	}
}

function formatDate(value: string | null): string {
	if (!value) return 'Never';
	return new Date(value).toLocaleString();
}

// Load passkeys whenever the Security tab becomes active (covers direct
// URL entry, in-app navigation, and query-only navigation that reuses the
// same component instance)
watch(
	tab,
	(current) => {
		if (current === 'security') {
			loadPasskeys();
		}
	},
	{ immediate: true },
);
</script>

<template>
	<div class="mx-auto flex max-w-3xl flex-col gap-6">
		<header>
			<h1 class="text-heading-l text-fg">Settings</h1>
			<p class="mt-1 text-body-s text-fg-muted">Your profile, password and passkeys.</p>
		</header>

		<UiTabs v-model="tabModel" label="Settings sections" :items="tabs" />

		<!-- General -->
		<UiCard v-if="tab === 'general'" title="Profile" data-testid="settings-general">
			<form class="flex flex-col gap-4 p-4" @submit.prevent="saveProfile">
				<UiAlert v-if="profileError" tone="error" data-testid="profile-error">
					{{ profileError }}
				</UiAlert>
				<UiAlert v-if="profileSuccess" tone="success" data-testid="profile-success">
					Profile updated
				</UiAlert>
				<div class="grid gap-4 sm:grid-cols-2">
					<UiFormField v-slot="f" label="Display name" id="profile-name">
						<UiInput
							:id="f.id"
							v-model="profileName"
							type="text"
							maxlength="100"
							required
							data-testid="profile-name-input"
						/>
					</UiFormField>
					<UiFormField
						v-slot="f"
						label="Email"
						id="profile-email"
						help="Your sign-in identifier — you'll use the new one next time you sign in."
					>
						<!-- type="text" on purpose: the server deliberately applies no
							email-format validation, and a type="email" input would impose
							browser constraint validation the endpoint doesn't have -->
						<UiInput
							:id="f.id"
							v-model="profileEmail"
							:aria-describedby="f.describedBy"
							type="text"
							autocomplete="username"
							inputmode="email"
							maxlength="254"
							required
							data-testid="profile-email-input"
						/>
					</UiFormField>
				</div>
				<div class="flex items-center gap-2 text-body-s">
					<span class="text-fg-subtle">Role</span>
					<UiTag>{{ authStore.user?.role }}</UiTag>
				</div>
				<div class="flex items-center gap-3 border-t border-border pt-4">
					<UiButton
						type="submit"
						variant="primary"
						:loading="savingProfile"
						:disabled="!profileDirty"
						data-testid="profile-save"
					>
						{{ savingProfile ? 'Saving…' : 'Save changes' }}
					</UiButton>
					<p class="text-caption text-fg-subtle">Passkeys and passwords live under Security.</p>
				</div>
			</form>
		</UiCard>

		<!-- Security -->
		<div v-else class="flex flex-col gap-6">
			<!-- Admin tools unlock note (admins on password sessions) -->
			<UiAlert
				v-if="authStore.isAdmin && !authStore.canUseAdmin"
				tone="info"
				data-testid="admin-passkey-note"
			>
				Sign out and back in with your passkey to unlock admin tools. Admin actions require
				a passkey-signed-in session.
			</UiAlert>

			<!-- Change password -->
			<UiCard
				title="Change password"
				meta="Signs you out of every device"
				data-testid="settings-change-password"
			>
				<form class="flex flex-col gap-4 p-4" @submit.prevent="changePassword">
					<UiAlert v-if="passwordError" tone="error">{{ passwordError }}</UiAlert>
					<UiFormField v-slot="f" label="Current password" id="current-password">
						<UiInput :id="f.id" v-model="currentPassword" type="password" autocomplete="current-password" required />
					</UiFormField>
					<div class="grid gap-4 sm:grid-cols-2">
						<UiFormField v-slot="f" label="New password" id="new-password" help="At least 8 characters">
							<UiInput
								:id="f.id"
								v-model="newPassword"
								:aria-describedby="f.describedBy"
								type="password"
								autocomplete="new-password"
								required
							/>
						</UiFormField>
						<UiFormField v-slot="f" label="Confirm new password" id="confirm-password">
							<UiInput :id="f.id" v-model="confirmPassword" type="password" autocomplete="new-password" required />
						</UiFormField>
					</div>
					<div class="border-t border-border pt-4">
						<UiButton
							type="submit"
							variant="primary"
							:icon="KeyRound"
							:loading="changingPassword"
							data-testid="change-password-submit"
						>
							{{ changingPassword ? 'Changing…' : 'Change password' }}
						</UiButton>
					</div>
				</form>
			</UiCard>

			<!-- Passkeys -->
			<UiCard
				title="Passkeys"
				meta="Fingerprint, face or security key"
				data-testid="settings-passkeys"
			>
				<UiAlert v-if="passkeyError" tone="error" class="m-4 mb-0">{{ passkeyError }}</UiAlert>

				<UiSkeleton v-if="passkeysLoading" variant="line" :count="2" label="Loading passkeys" class="p-4" />

				<ul v-else-if="passkeys.length > 0" class="divide-y divide-border">
					<li
						v-for="credential in passkeys"
						:key="credential.id"
						class="flex items-center gap-3 px-4 py-3"
					>
						<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
							<Fingerprint :size="18" aria-hidden="true" />
						</span>
						<div class="min-w-0 flex-1">
							<p class="truncate text-body-s font-medium text-fg">{{ credential.name }}</p>
							<p class="text-caption text-fg-subtle">
								Created {{ formatDate(credential.createdAt) }} · Last used {{ formatDate(credential.lastUsedAt) }}
							</p>
						</div>
						<UiButton
							variant="danger"
							size="sm"
							:icon="Trash2"
							:loading="deletingPasskeyId === credential.id"
							:title="isLastPasskey ? 'This is your last passkey — password sign-in will still work' : undefined"
							@click="removePasskey(credential)"
						>
							{{ deletingPasskeyId === credential.id ? 'Deleting…' : 'Delete' }}
						</UiButton>
					</li>
				</ul>
				<p v-else class="px-4 py-4 text-body-s text-fg-muted">No passkeys yet.</p>

				<form
					class="flex flex-col gap-3 border-t border-border bg-canvas/40 p-4 sm:flex-row sm:items-end"
					@submit.prevent="addPasskey"
				>
					<UiFormField v-slot="f" label="Add a passkey" id="new-passkey-name" class="flex-1">
						<UiInput
							:id="f.id"
							v-model="newPasskeyName"
							type="text"
							placeholder="e.g. YubiKey 5C, iPhone"
							data-testid="new-passkey-name"
						/>
					</UiFormField>
					<UiButton
						type="submit"
						variant="primary"
						:icon="Plus"
						:loading="addingPasskey"
						data-testid="add-passkey-button"
					>
						{{ addingPasskey ? 'Waiting…' : 'Add passkey' }}
					</UiButton>
				</form>
			</UiCard>
		</div>
	</div>
</template>
