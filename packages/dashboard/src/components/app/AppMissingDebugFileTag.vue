<script setup lang="ts">
import { ArrowUpRight, TriangleAlert } from 'lucide-vue-next';
import type { RouteLocationRaw } from 'vue-router';
import { type DebugPlatform, MISSING_LABEL } from '../../lib/debug-files';

/**
 * Warning tag on a crash whose debug file is not uploaded. It is a link to
 * the upload tab of that platform in Project settings.
 */
const props = defineProps<{ platform: DebugPlatform; to: RouteLocationRaw }>();
const label = MISSING_LABEL[props.platform];
</script>

<template>
	<RouterLink
		:to="to"
		class="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md bg-level-warning-bg py-0.5 pr-2 pl-1.5 text-caption text-level-warning transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-level-warning"
		:title="`${label}: upload it to read this crash`"
		data-testid="missing-debug-file"
	>
		<TriangleAlert :size="12" aria-hidden="true" />
		{{ label }}
		<ArrowUpRight :size="12" aria-hidden="true" />
	</RouterLink>
</template>
