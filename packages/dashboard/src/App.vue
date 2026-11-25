<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterView } from 'vue-router';
import UiConfirmHost from './components/ui/UiConfirmHost.vue';
import UiToaster from './components/ui/UiToaster.vue';
import { useAuthStore } from './stores/auth';

const authStore = useAuthStore();

onMounted(async () => {
	await authStore.checkAuth();
});
</script>

<template>
	<div class="min-h-screen bg-canvas text-fg">
		<RouterView />
	</div>
	<!-- App-wide hosts for useToast() and useConfirm() -->
	<UiToaster />
	<UiConfirmHost />
</template>
