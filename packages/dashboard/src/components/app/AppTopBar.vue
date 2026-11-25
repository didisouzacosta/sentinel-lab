<script setup lang="ts">
import { ChevronRight, Menu } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';

export interface Crumb {
	label: string;
	to?: string;
}

defineProps<{ crumbs: Crumb[] }>();
defineEmits<{ 'open-menu': [] }>();
</script>

<template>
	<header class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-canvas/90 px-3 backdrop-blur sm:px-6">
		<button
			type="button"
			class="inline-flex size-10 items-center justify-center rounded-lg text-fg hover:bg-subtle lg:hidden"
			aria-label="Open navigation"
			data-testid="open-navigation"
			@click="$emit('open-menu')"
		>
			<Menu :size="20" aria-hidden="true" />
		</button>
		<nav aria-label="Breadcrumb" class="min-w-0 flex-1">
			<ol class="flex min-w-0 items-center gap-1.5 text-body-s font-medium">
				<li v-for="(crumb, i) in crumbs" :key="i" class="flex min-w-0 items-center gap-1.5" :class="i < crumbs.length - 1 ? 'hidden sm:flex' : ''">
					<ChevronRight v-if="i > 0" :size="14" class="hidden shrink-0 text-fg-subtle sm:block" aria-hidden="true" />
					<RouterLink v-if="crumb.to && i < crumbs.length - 1" :to="crumb.to" class="truncate text-fg-subtle hover:text-fg">
						{{ crumb.label }}
					</RouterLink>
					<span v-else class="truncate" :class="i === crumbs.length - 1 ? 'text-fg' : 'text-fg-subtle'" :aria-current="i === crumbs.length - 1 ? 'page' : undefined">
						{{ crumb.label }}
					</span>
				</li>
			</ol>
		</nav>
		<slot name="actions" />
	</header>
</template>
