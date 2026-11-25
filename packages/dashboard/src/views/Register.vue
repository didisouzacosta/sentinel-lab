<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import AuthShell from '../components/app/AuthShell.vue';
import { UiAlert, UiButton, UiFormField, UiInput } from '../components/ui';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const name = ref('');
const email = ref('');
const password = ref('');

async function handleSubmit() {
	const success = await authStore.register(email.value, password.value, name.value);
	if (success) {
		router.push('/');
	}
}
</script>

<template>
	<AuthShell>
		<header class="flex flex-col gap-1.5">
			<h1 class="text-heading-l text-fg">Create your account</h1>
			<p class="text-body-s text-fg-muted">
				Already have an account?
				<RouterLink to="/login" class="font-medium text-accent-text hover:underline">Sign in</RouterLink>
			</p>
		</header>

		<form class="flex flex-col gap-5" @submit.prevent="handleSubmit">
			<UiAlert v-if="authStore.error" tone="error">{{ authStore.error }}</UiAlert>

			<UiFormField v-slot="f" label="Name" id="name">
				<UiInput :id="f.id" v-model="name" type="text" autocomplete="name" required placeholder="John Doe" />
			</UiFormField>

			<UiFormField v-slot="f" label="Email address" id="email">
				<UiInput
					:id="f.id"
					v-model="email"
					type="email"
					autocomplete="email"
					required
					placeholder="you@example.com"
				/>
			</UiFormField>

			<UiFormField v-slot="f" label="Password" id="password" help="At least 8 characters">
				<UiInput
					:id="f.id"
					v-model="password"
					:aria-describedby="f.describedBy"
					type="password"
					autocomplete="new-password"
					required
					minlength="8"
					placeholder="••••••••"
				/>
			</UiFormField>

			<UiButton type="submit" variant="primary" class="h-11 w-full" :loading="authStore.loading">
				{{ authStore.loading ? 'Creating account...' : 'Create account' }}
			</UiButton>
		</form>
	</AuthShell>
</template>
