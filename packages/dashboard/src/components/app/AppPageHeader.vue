<script setup lang="ts">
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
	<header class="flex flex-wrap items-center gap-3">
		<div class="min-w-0 flex-1">
			<h1 class="text-heading-l text-fg">{{ title }}</h1>
			<p v-if="subtitle || $slots.subtitle" class="mt-1 text-body-s text-fg-muted">
				<slot name="subtitle">{{ subtitle }}</slot>
			</p>
		</div>
		<div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
			<slot name="actions" />
		</div>
	</header>
</template>
