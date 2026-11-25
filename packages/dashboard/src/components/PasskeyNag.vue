<script setup lang="ts">
import { Fingerprint } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { UiAlert, UiButton, UiDialog, UiFormField, UiInput } from './ui';

const authStore = useAuthStore();

const name = ref('');
const creating = ref(false);
const error = ref<string | null>(null);

const visible = computed(
	() => authStore.isAuthenticated && !authStore.hasPasskey && !authStore.dismissedForThisVisit,
);

async function createPasskey() {
	const trimmed = name.value.trim();
	if (!trimmed) {
		error.value = 'Give the passkey a name first';
		return;
	}
	creating.value = true;
	error.value = null;
	try {
		await authStore.registerPasskey(trimmed);
		// Success flips hasPasskey to true, which hides the modal
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Passkey creation failed';
	} finally {
		creating.value = false;
	}
}

function notNow() {
	authStore.dismissPasskeyNag();
}

// Esc, backdrop and × mean "not now" (in-memory, per visit)
const open = computed({
	get: () => visible.value,
	set: (v: boolean) => {
		if (!v) notNow();
	},
});
</script>

<template>
	<UiDialog
		v-if="visible"
		v-model:open="open"
		title="Secure your account with a passkey"
		description="Recommended for every account; required to use administration tools."
		form
		data-testid="passkey-nag"
		@submit="createPasskey"
	>
		<div class="flex flex-col gap-4">
			<div class="flex items-start gap-3">
				<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-text">
					<Fingerprint :size="18" aria-hidden="true" />
				</span>
				<p class="text-body-s text-fg-muted">
					A passkey lets you sign in with a fingerprint, face, or security key — no password needed.
					It stays on your device and is phishing-resistant. You'll be asked again on your next visit
					if you skip this now.
				</p>
			</div>
			<UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
			<UiFormField v-slot="f" label="Name this passkey" id="passkey-name">
				<UiInput
					:id="f.id"
					v-model="name"
					type="text"
					autofocus
					placeholder="e.g. YubiKey 5C, iPhone"
					data-testid="passkey-name-input"
				/>
			</UiFormField>
		</div>
		<template #footer>
			<UiButton variant="ghost" data-testid="passkey-nag-dismiss" :disabled="creating" @click="notNow">
				Not now
			</UiButton>
			<UiButton
				type="submit"
				variant="primary"
				:icon="Fingerprint"
				:loading="creating"
				data-testid="passkey-nag-create"
			>
				{{ creating ? 'Creating…' : 'Create passkey' }}
			</UiButton>
		</template>
	</UiDialog>
</template>
