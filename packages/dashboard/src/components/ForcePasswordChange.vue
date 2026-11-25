<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import AuthShell from './app/AuthShell.vue';
import { UiAlert, UiButton, UiFormField, UiInput } from './ui';

const authStore = useAuthStore();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const saving = ref(false);
const error = ref<string | null>(null);

async function submit() {
	error.value = null;

	if (newPassword.value.length < 8) {
		error.value = 'New password must be at least 8 characters';
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		error.value = 'New passwords do not match';
		return;
	}

	saving.value = true;
	try {
		// The server revokes every session on success; the store's
		// changePassword already logs out locally and clears the token.
		await authStore.changePassword(currentPassword.value, newPassword.value);
		// The router guard sends the (now anonymous) visitor to /login
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to change password';
		saving.value = false;
	}
}
</script>

<template>
	<!-- Replaces the whole app until the temporary password is changed -->
	<div data-testid="force-password-change">
		<AuthShell>
			<header class="flex flex-col gap-3">
				<h1 class="text-heading-l text-fg">Set a new password</h1>
				<UiAlert tone="warning">
					Your account was created or reset by an administrator with a temporary password.
					Choose a new password to continue — everything else stays blocked until then.
				</UiAlert>
			</header>

			<form class="flex flex-col gap-5" @submit.prevent="submit">
				<UiFormField v-slot="f" label="Current password (the temporary one)" id="force-current">
					<UiInput
						:id="f.id"
						v-model="currentPassword"
						type="password"
						required
						autocomplete="current-password"
						data-testid="force-password-current"
					/>
				</UiFormField>
				<UiFormField v-slot="f" label="New password" id="force-new" help="At least 8 characters">
					<UiInput
						:id="f.id"
						v-model="newPassword"
						:aria-describedby="f.describedBy"
						type="password"
						required
						autocomplete="new-password"
						data-testid="force-password-new"
					/>
				</UiFormField>
				<UiFormField v-slot="f" label="Confirm new password" id="force-confirm">
					<UiInput
						:id="f.id"
						v-model="confirmPassword"
						type="password"
						required
						autocomplete="new-password"
						data-testid="force-password-confirm"
					/>
				</UiFormField>

				<UiAlert v-if="error" tone="error" data-testid="force-password-error">{{ error }}</UiAlert>

				<UiButton
					type="submit"
					variant="primary"
					class="h-11 w-full"
					:loading="saving"
					:disabled="!currentPassword || !newPassword || !confirmPassword"
					data-testid="force-password-submit"
				>
					{{ saving ? 'Saving…' : 'Set password and sign in again' }}
				</UiButton>
			</form>
		</AuthShell>
	</div>
</template>
