<script setup lang="ts">
import { Fingerprint } from 'lucide-vue-next';
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import AuthShell from '../components/app/AuthShell.vue';
import { UiAlert, UiButton, UiFormField, UiInput } from '../components/ui';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');
const passkeyBusy = ref(false);
const passkeyError = ref<string | null>(null);

async function handleSubmit() {
	const success = await authStore.login(email.value, password.value);
	if (success) {
		router.push('/');
	}
}

/** Single-step usernameless sign-in: no email field involved. */
async function handlePasskey() {
	passkeyBusy.value = true;
	passkeyError.value = null;
	try {
		await authStore.loginWithPasskey();
		router.push('/');
	} catch (err) {
		// Browser-ceremony failures (no matching passkey, user cancel) get the
		// friendly message; server errors surface their own message.
		const isServerError = typeof err === 'object' && err !== null && 'status' in err;
		passkeyError.value = isServerError
			? err instanceof Error
				? err.message
				: 'Passkey sign-in failed'
			: 'No passkey found for this site — try email sign-in or register one after signing in.';
	} finally {
		passkeyBusy.value = false;
	}
}
</script>

<template>
	<AuthShell>
		<header class="flex flex-col gap-1.5">
			<h1 class="text-heading-l text-fg">Sign in to Sentinel</h1>
			<p class="text-body-s text-fg-muted">
				Or
				<RouterLink to="/register" class="font-medium text-accent-text hover:underline">
					create a new account
				</RouterLink>
			</p>
		</header>

		<form class="flex flex-col gap-5" @submit.prevent="handleSubmit">
			<div class="flex flex-col gap-2.5">
				<UiButton
					variant="primary"
					class="h-11 w-full"
					:icon="Fingerprint"
					:loading="passkeyBusy"
					data-testid="passkey-login-button"
					@click="handlePasskey"
				>
					{{ passkeyBusy ? 'Waiting for passkey…' : 'Sign in with a passkey' }}
				</UiButton>
				<p class="text-center text-caption text-fg-subtle">
					No email needed — use your fingerprint, face, or security key
				</p>
				<UiAlert v-if="passkeyError" tone="error" data-testid="passkey-login-error">
					{{ passkeyError }}
				</UiAlert>
			</div>

			<div class="flex items-center gap-3 text-caption text-fg-subtle" role="separator">
				<span class="h-px flex-1 bg-border" />
				or sign in with email
				<span class="h-px flex-1 bg-border" />
			</div>

			<UiAlert v-if="authStore.error" tone="error">{{ authStore.error }}</UiAlert>

			<UiFormField v-slot="f" label="Email address" id="email">
				<!-- type="text" on purpose: profile edits deliberately accept
					format-free identifiers (the profile endpoint applies no
					email-format validation), and a type="email" input would let
					the browser block signing in with one. The server only
					trims/lowercases. -->
				<UiInput
					:id="f.id"
					v-model="email"
					type="text"
					autocomplete="username"
					inputmode="email"
					required
					placeholder="you@example.com"
				/>
			</UiFormField>

			<UiFormField v-slot="f" label="Password" id="password">
				<UiInput
					:id="f.id"
					v-model="password"
					type="password"
					autocomplete="current-password"
					required
					placeholder="••••••••"
				/>
			</UiFormField>

			<UiButton type="submit" class="h-11 w-full" :loading="authStore.loading">
				{{ authStore.loading ? 'Signing in...' : 'Sign in' }}
			</UiButton>
		</form>
	</AuthShell>
</template>
