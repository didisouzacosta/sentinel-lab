<script setup lang="ts">
import { Activity } from 'lucide-vue-next';
import type { Component } from 'vue';

withDefaults(defineProps<{ title: string; description?: string; icon?: Component }>(), {
	icon: () => Activity,
});
</script>

<template>
	<div class="flex flex-col items-center gap-2.5 px-6 py-10 text-center">
		<span class="flex size-11 items-center justify-center rounded-full bg-subtle text-fg-muted">
			<component :is="icon" :size="20" aria-hidden="true" />
		</span>
		<h3 class="text-heading-m text-fg">{{ title }}</h3>
		<p v-if="description" class="max-w-sm text-body-s text-fg-muted">{{ description }}</p>
		<div v-if="$slots.default" class="mt-1.5 flex items-center gap-2"><slot /></div>
	</div>
</template>
