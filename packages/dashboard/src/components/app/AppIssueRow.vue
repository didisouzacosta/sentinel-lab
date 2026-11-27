<script setup lang="ts">
import { type RouteLocationRaw, RouterLink } from 'vue-router';
import {
	type MissingDebugFile,
	missingByPlatform,
	platformOf,
	uploadLink,
} from '../../lib/debug-files';
import { formatNumber, timeAgo } from '../../lib/format';
import UiBadge from '../ui/UiBadge.vue';
import AppMissingDebugFileTag from './AppMissingDebugFileTag.vue';

export interface IssueRowData {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	lastSeen: string;
	firstSeen?: string;
	count: number;
	userCount: number;
	metadata?: { type?: string; value?: string };
	missingDebugFiles?: MissingDebugFile[];
}

/** `slug` turns on the missing-debug-file tags (they link to that project's upload tab). */
defineProps<{ issue: IssueRowData; to: RouteLocationRaw; slug?: string }>();
</script>

<template>
	<!-- One issue: type + message, culprit and age on the left; numbers on the right
	     (they fold under the text on phones). The issue link is stretched over the
	     row, so the missing-debug-file tag can be a link of its own. -->
	<div
		class="relative flex flex-col gap-2 px-4 py-3 transition-colors focus-within:bg-raised hover:bg-raised sm:flex-row sm:items-center sm:gap-4"
	>
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<div class="flex min-w-0 items-center gap-2">
				<UiBadge :level="issue.level" />
				<RouterLink :to="to" class="flex min-w-0 items-center gap-2 outline-none after:absolute after:inset-0">
					<span class="shrink-0 text-body font-medium text-fg">{{ issue.metadata?.type || issue.title }}</span>
					<span class="min-w-0 truncate text-body text-fg-muted">{{ issue.metadata?.value || issue.title }}</span>
				</RouterLink>
				<template v-if="slug">
					<AppMissingDebugFileTag
						v-for="file in missingByPlatform(issue.missingDebugFiles)"
						:key="file.debugId"
						:platform="platformOf(file.kind)"
						:to="uploadLink(slug, file, issue.id)"
					/>
				</template>
			</div>
			<div class="flex min-w-0 items-center gap-2 text-caption text-fg-subtle">
				<span v-if="issue.culprit" class="min-w-0 truncate font-mono">{{ issue.culprit }}</span>
				<span v-if="issue.culprit && issue.firstSeen" aria-hidden="true">·</span>
				<span v-if="issue.firstSeen" class="shrink-0">first seen {{ timeAgo(issue.firstSeen) }}</span>
			</div>
		</div>
		<dl class="flex shrink-0 items-center gap-4 text-body-s sm:gap-0" data-numeric>
			<div class="sm:w-24 sm:text-right">
				<dt class="sr-only">Last seen</dt>
				<dd class="text-fg-subtle">{{ timeAgo(issue.lastSeen) }}</dd>
			</div>
			<div class="sm:w-20 sm:text-right">
				<dt class="sr-only">Events</dt>
				<dd class="font-medium text-fg">{{ formatNumber(issue.count) }}<span class="text-fg-subtle sm:hidden"> events</span></dd>
			</div>
			<div class="sm:w-20 sm:text-right">
				<dt class="sr-only">Users</dt>
				<dd class="font-medium text-fg">{{ formatNumber(issue.userCount) }}<span class="text-fg-subtle sm:hidden"> users</span></dd>
			</div>
		</dl>
	</div>
</template>
