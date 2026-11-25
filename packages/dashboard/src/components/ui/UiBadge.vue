<script setup lang="ts">
import { computed } from 'vue';

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';
export type IssueStatus = 'unresolved' | 'resolved' | 'ignored' | 'snoozed';

const props = defineProps<{
	/** Event level: dot + level name, same colors as rows and charts. */
	level?: Level | string;
	/** Issue status pill. */
	status?: IssueStatus | string;
}>();

const LEVEL: Record<Level, string> = {
	fatal: 'bg-level-fatal-bg text-level-fatal',
	error: 'bg-level-error-bg text-level-error',
	warning: 'bg-level-warning-bg text-level-warning',
	info: 'bg-level-info-bg text-level-info',
	debug: 'bg-level-debug-bg text-level-debug',
};
const STATUS: Record<IssueStatus, [string, string]> = {
	unresolved: ['bg-accent-subtle text-accent-text', 'Unresolved'],
	resolved: ['bg-success-bg text-success', 'Resolved'],
	ignored: ['bg-level-debug-bg text-level-debug', 'Ignored'],
	snoozed: ['bg-level-warning-bg text-level-warning', 'Snoozed'],
};

const levelClass = computed(() => LEVEL[(props.level as Level) ?? 'error'] ?? LEVEL.debug);
const statusEntry = computed(() => STATUS[props.status as IssueStatus] ?? STATUS.ignored);
</script>

<template>
	<span
		v-if="status"
		:class="['inline-flex h-[22px] items-center rounded-full px-2 text-caption font-medium', statusEntry[0]]"
	>
		<slot>{{ statusEntry[1] }}</slot>
	</span>
	<span
		v-else
		:class="['inline-flex h-5 items-center gap-1.5 rounded-md pr-2 pl-1.5 text-caption font-medium', levelClass]"
	>
		<span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
		<slot>{{ level }}</slot>
	</span>
</template>
