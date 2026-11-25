<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api/client';
import AppPageHeader from '../../components/app/AppPageHeader.vue';
import { UiAlert, UiCard, UiSkeleton, UiSwitch, UiTag } from '../../components/ui';
import { useToast } from '../../composables/useToast';

const toast = useToast();

const registrationOpen = ref<boolean | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

async function load() {
	loading.value = true;
	error.value = null;
	try {
		const response = await api.get<{ settings: { registrationOpen: boolean } }>(
			'/api/admin/settings',
		);
		registrationOpen.value = response.settings.registrationOpen;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load settings';
	} finally {
		loading.value = false;
	}
}

onMounted(load);

async function toggleRegistration() {
	if (registrationOpen.value === null) return;
	saving.value = true;
	error.value = null;
	try {
		const response = await api.put<{ settings: { registrationOpen: boolean } }>(
			'/api/admin/settings',
			{ registrationOpen: !registrationOpen.value },
		);
		registrationOpen.value = response.settings.registrationOpen;
		toast.success(registrationOpen.value ? 'Registration opened' : 'Registration closed');
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to update settings');
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<div class="flex max-w-3xl flex-col gap-5">
		<AppPageHeader title="Settings" subtitle="Instance-wide options" />

		<UiSkeleton v-if="loading" variant="block" label="Loading settings" class="h-28" />

		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="load">{{ error }}</UiAlert>

		<UiCard v-else title="Registration">
			<div class="flex items-center gap-4 px-4 py-4">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span id="registration-label" class="text-body-s font-medium text-fg">Open registration</span>
						<UiTag :tone="registrationOpen ? 'accent' : 'neutral'" data-testid="admin-settings-registration-state">{{ registrationOpen ? 'Open' : 'Closed' }}</UiTag>
					</div>
					<p id="registration-help" class="mt-1 text-body-s text-fg-muted">
						Anyone can create an account (the first account on a fresh install still needs the setup token).
						When off, only administrators add users.
					</p>
				</div>
				<UiSwitch
					:model-value="!!registrationOpen"
					:disabled="saving"
					aria-labelledby="registration-label"
					aria-describedby="registration-help"
					data-testid="admin-settings-registration-toggle"
					@update:model-value="toggleRegistration"
				/>
			</div>
		</UiCard>
	</div>
</template>
