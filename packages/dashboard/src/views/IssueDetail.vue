<script setup lang="ts">
import { Check, Clock, Copy, Download, Eye, EyeOff, FileJson, Trash2 } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import AttachmentList from '../components/AttachmentList.vue';
import AppStackFrame from '../components/app/AppStackFrame.vue';
import {
	UiAlert,
	UiAvatar,
	UiBadge,
	UiButton,
	UiCard,
	UiDescriptionList,
	UiFormField,
	UiInput,
	UiMarkdown,
	UiMenu,
	UiSegmented,
	UiSelect,
	UiSkeleton,
	UiTag,
} from '../components/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { timeAgo } from '../lib/format';
import { issueExportFilename, issueExportJson } from '../lib/issue-export';
import { renderMarkdown } from '../lib/markdown';
import { type ResolvedFrame, resolveFrame } from '../lib/sourcemap-resolver';
import { useAuthStore } from '../stores/auth';
import { useProjectsStore } from '../stores/projects';

interface Issue {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	platform: string;
	firstSeen: string;
	lastSeen: string;
	count: number;
	userCount: number;
	status: string;
	snoozedUntil: string | null;
	metadata: {
		type: string;
		value: string;
	};
}

interface StackFrame {
	filename?: string;
	function?: string;
	lineno?: number;
	colno?: number;
	context_line?: string;
	pre_context?: string[];
	post_context?: string[];
	in_app?: boolean;
}

interface Event {
	event_id: string;
	timestamp: string;
	level: string;
	platform: string;
	environment?: string;
	release?: string;
	message?: string;
	tags?: Record<string, string>;
	user?: {
		id?: string;
		email?: string;
		ip_address?: string;
	};
	exception?: {
		values: Array<{
			type: string;
			value: string;
			stacktrace?: {
				frames: StackFrame[];
			};
		}>;
	};
	breadcrumbs?: Array<{
		type?: string;
		category?: string;
		message?: string;
		level?: string;
		timestamp?: string;
	}>;
}

interface Activity {
	id: string;
	issueId: string;
	userId: string;
	userName: string;
	type: 'comment' | 'status_change';
	data: Record<string, string>;
	createdAt: string;
}

const route = useRoute();
const authStore = useAuthStore();
const toast = useToast();
const askConfirm = useConfirm();
const slug = computed(() => route.params.slug as string);
const issueId = computed(() => route.params.issueId as string);

const issue = ref<Issue | null>(null);
const events = ref<Event[]>([]);
const selectedEvent = ref<Event | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const expandedFrames = ref<Set<number>>(new Set());
const showOriginal = ref(true);
const resolvedFrames = ref<Map<number, ResolvedFrame>>(new Map());
const resolving = ref(false);
const activity = ref<Activity[]>([]);
const newComment = ref('');
const submittingComment = ref(false);

const projectsStore = useProjectsStore();

// Export: the whole issue (and the event on screen) as JSON, for pasting
// into an AI assistant or attaching to a ticket (lib/issue-export.ts).
const EXPORT_OPTIONS = [
	{
		value: 'copy',
		label: 'Copy as JSON',
		icon: Copy,
		description: 'Paste it into an AI assistant',
	},
	{ value: 'download', label: 'Download .json', icon: Download },
];

function exportPayload(): string {
	return issueExportJson({
		project: {
			slug: slug.value,
			name: projectsStore.projects.find((p) => p.slug === slug.value)?.name,
		},
		issue: issue.value as unknown as Record<string, unknown> & { id: string },
		event: selectedEvent.value as unknown as
			| (Record<string, unknown> & { event_id: string })
			| null,
		events: events.value as unknown as Array<Record<string, unknown> & { event_id: string }>,
		resolvedFrames: resolvedFrames.value,
		activity: activity.value as unknown as Array<Record<string, unknown>>,
		issueUrl: window.location.href.split('?')[0],
	});
}

async function exportIssue(kind: string) {
	if (!issue.value) return;
	const json = exportPayload();
	if (kind === 'copy') {
		try {
			await navigator.clipboard.writeText(json);
			toast.success('Issue copied as JSON — paste it into your AI assistant');
		} catch {
			toast.error('Could not copy to the clipboard. Try "Download .json".');
		}
		return;
	}
	const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = issueExportFilename(slug.value, issue.value.id);
	link.click();
	URL.revokeObjectURL(url);
}

const SNOOZE_OPTIONS = [
	{ value: '1h', label: '1 hour', icon: Clock },
	{ value: '1d', label: '1 day', icon: Clock },
	{ value: '3d', label: '3 days', icon: Clock },
	{ value: '1w', label: '1 week', icon: Clock },
];
const sourceView = computed({
	get: () => (showOriginal.value ? 'original' : 'minified'),
	set: (v: string) => {
		showOriginal.value = v === 'original';
	},
});
const selectedEventId = computed({
	get: () => selectedEvent.value?.event_id ?? '',
	set: (id: string) => {
		selectedEvent.value = events.value.find((e) => e.event_id === id) || null;
	},
});
// Offer Original/Minified only when a source map actually matched a frame
const anyMapped = computed(() => [...resolvedFrames.value.values()].some((r) => r.resolved));
const selectedIndex = computed(() =>
	events.value.findIndex((e) => e.event_id === selectedEvent.value?.event_id),
);
const eventInfo = computed(() => {
	const e = selectedEvent.value;
	if (!e) return [];
	return [
		{ label: 'Event ID', value: e.event_id, mono: true },
		{ label: 'Timestamp', value: formatTime(e.timestamp) },
		...(e.environment ? [{ label: 'Environment', value: e.environment }] : []),
		...(e.release ? [{ label: 'Release', value: e.release, mono: true }] : []),
	];
});
const userInfo = computed(() => {
	const u = selectedEvent.value?.user;
	if (!u) return [];
	return [
		...(u.id ? [{ label: 'ID', value: u.id, mono: true }] : []),
		...(u.email ? [{ label: 'Email', value: u.email }] : []),
		...(u.ip_address ? [{ label: 'IP Address', value: u.ip_address, mono: true }] : []),
	];
});
const levelText: Record<string, string> = {
	fatal: 'text-level-fatal',
	error: 'text-level-error',
	warning: 'text-level-warning',
	info: 'text-level-info',
	debug: 'text-level-debug',
};
const STATUS_DONE: Record<string, string> = {
	resolved: 'resolved',
	ignored: 'ignored',
	unresolved: 'reopened',
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

const isSnoozed = computed(
	() => issue.value?.snoozedUntil && new Date(issue.value.snoozedUntil) > new Date(),
);

/**
 * The selected event's message — the exception value, or a message-only
 * event's top-level message (same priority the ingest-side metadata
 * extraction uses). The full text lives in the Message box; the page
 * title carries only its first 80 characters.
 */
const eventMessage = computed(() => {
	const event = selectedEvent.value;
	if (!event) return '';
	return event.exception?.values?.[0]?.value || event.message || '';
});

const renderedMessage = computed(() =>
	eventMessage.value ? renderMarkdown(eventMessage.value) : '',
);

const titleValue = computed(() => {
	const value = issue.value?.metadata.value ?? '';
	return value.length > 80 ? `${value.slice(0, 80)}…` : value;
});

async function snoozeIssue(duration: string) {
	if (!issue.value) return;
	try {
		const response = await api.post<{ issue: Issue }>(
			`/api/projects/${slug.value}/issues/${issueId.value}/snooze`,
			{ duration },
		);
		issue.value.snoozedUntil = response.issue.snoozedUntil;
		toast.success(`Snoozed until ${formatTime(response.issue.snoozedUntil ?? '')}`, {
			action: { label: 'Undo', onClick: () => void unsnoozeIssue() },
		});
	} catch (err) {
		toast.error(`Could not snooze the issue: ${errorText(err)}`);
	}
}

async function unsnoozeIssue() {
	if (!issue.value) return;
	try {
		await api.delete(`/api/projects/${slug.value}/issues/${issueId.value}/snooze`);
		issue.value.snoozedUntil = null;
		toast.success('Issue unsnoozed');
	} catch (err) {
		toast.error(`Could not unsnooze the issue: ${errorText(err)}`);
	}
}

async function loadIssue() {
	loading.value = true;
	error.value = null;

	try {
		const [issueResponse, eventsResponse, activityResponse] = await Promise.all([
			api.get<{ issue: Issue }>(`/api/projects/${slug.value}/issues/${issueId.value}`),
			api.get<{ events: Event[] }>(
				`/api/projects/${slug.value}/issues/${issueId.value}/events?limit=10`,
			),
			api.get<{ activity: Activity[] }>(
				`/api/projects/${slug.value}/issues/${issueId.value}/activity`,
			),
		]);

		issue.value = issueResponse.issue;
		events.value = eventsResponse.events;
		selectedEvent.value = eventsResponse.events[0] || null;
		activity.value = activityResponse.activity;
		resolveStackFrames();
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load issue';
	} finally {
		loading.value = false;
	}
}

async function resolveStackFrames() {
	const event = selectedEvent.value;
	if (!event?.release || !event.exception?.values?.[0]?.stacktrace?.frames) {
		return;
	}

	resolving.value = true;
	const frames = getStackFrames();
	const newResolved = new Map<number, ResolvedFrame>();

	const promises = frames.map(async (frame, displayIndex) => {
		const result = await resolveFrame(slug.value, event.release!, {
			filename: frame.filename,
			lineno: frame.lineno,
			colno: frame.colno,
		});
		newResolved.set(displayIndex, result);
	});

	await Promise.all(promises);
	resolvedFrames.value = newResolved;
	resolving.value = false;
}

watch(selectedEvent, () => {
	resolvedFrames.value = new Map();
	resolveStackFrames();
});

async function updateStatus(newStatus: string) {
	if (!issue.value) return;

	try {
		await api.patch(`/api/projects/${slug.value}/issues/${issueId.value}`, { status: newStatus });
		issue.value.status = newStatus;
		toast.success(`Issue ${STATUS_DONE[newStatus] ?? 'updated'}`);
		await loadActivity();
	} catch (err) {
		toast.error(`Could not update the issue: ${errorText(err)}`);
	}
}

async function loadActivity() {
	try {
		const response = await api.get<{ activity: Activity[] }>(
			`/api/projects/${slug.value}/issues/${issueId.value}/activity`,
		);
		activity.value = response.activity;
	} catch (err) {
		toast.error(`Could not refresh the activity: ${errorText(err)}`);
	}
}

async function addComment() {
	if (!newComment.value.trim() || submittingComment.value) return;

	submittingComment.value = true;
	try {
		await api.post(`/api/projects/${slug.value}/issues/${issueId.value}/comments`, {
			body: newComment.value.trim(),
		});
		newComment.value = '';
		await loadActivity();
	} catch (err) {
		toast.error(`Could not post comment: ${errorText(err)}`, {
			action: { label: 'Retry', onClick: () => void addComment() },
		});
	} finally {
		submittingComment.value = false;
	}
}

async function deleteComment(commentId: string) {
	const ok = await askConfirm({
		title: 'Delete this comment?',
		description: 'It is removed from the activity for everyone. This cannot be undone.',
		confirmLabel: 'Delete comment',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/projects/${slug.value}/issues/${issueId.value}/comments/${commentId}`);
		await loadActivity();
		toast.success('Comment deleted');
	} catch (err) {
		toast.error(`Could not delete the comment: ${errorText(err)}`);
	}
}

function formatTime(dateString: string): string {
	return new Date(dateString).toLocaleString();
}

function toggleFrame(index: number) {
	const next = new Set(expandedFrames.value);
	if (next.has(index)) next.delete(index);
	else next.add(index);
	expandedFrames.value = next;
}

function getStackFrames(): StackFrame[] {
	const exc = selectedEvent.value?.exception?.values?.[0];
	if (!exc?.stacktrace?.frames) return [];
	return [...exc.stacktrace.frames].reverse();
}

onMounted(() => loadIssue());
</script>

<template>
	<div>
		<!-- Loading -->
		<div v-if="loading" class="flex flex-col gap-5" data-testid="issue-loading">
			<UiSkeleton variant="line" :count="3" label="Loading issue" class="max-w-xl" />
			<UiSkeleton variant="block" label="Loading metrics" class="h-[70px]" />
			<div class="grid gap-5 lg:grid-cols-[1fr_340px]">
				<UiSkeleton variant="block" label="Loading stack trace" class="h-80" />
				<UiSkeleton variant="block" label="Loading event" class="h-48" />
			</div>
		</div>

		<!-- Error -->
		<UiAlert v-else-if="error" tone="error" action-label="Try again" @action="loadIssue">{{ error }}</UiAlert>

		<!-- Issue detail -->
		<div v-else-if="issue && selectedEvent" class="flex flex-col gap-5 max-sm:pb-20">
			<!-- Header -->
			<header class="flex flex-col gap-3">
				<div class="flex flex-wrap items-center gap-2">
					<UiBadge :level="issue.level" />
					<UiBadge :status="issue.status" />
					<UiTag v-if="selectedEvent.environment">{{ selectedEvent.environment }}</UiTag>
					<UiTag v-if="selectedEvent.release">{{ selectedEvent.release }}</UiTag>
				</div>
				<div class="flex flex-wrap items-start gap-3">
					<div class="min-w-0 flex-1">
						<h1 class="text-heading-l break-words text-fg">
							<span :class="levelText[issue.level] ?? 'text-level-info'">{{ issue.metadata.type }}:</span>
							{{ titleValue }}
						</h1>
						<p v-if="issue.culprit" class="mt-1 font-mono text-body-s text-fg-subtle">{{ issue.culprit }}</p>
					</div>
					<!-- Actions (desktop/tablet); phones get the fixed bar below -->
					<div class="flex flex-wrap items-center gap-2 max-sm:hidden">
						<UiButton v-if="issue.status !== 'resolved'" variant="primary" :icon="Check" @click="updateStatus('resolved')">Resolve</UiButton>
						<UiButton v-if="issue.status !== 'ignored'" :icon="EyeOff" @click="updateStatus('ignored')">Ignore</UiButton>
						<UiButton v-if="issue.status !== 'unresolved'" :icon="Eye" @click="updateStatus('unresolved')">Reopen</UiButton>
						<UiMenu v-if="!isSnoozed" label="Snooze" title="Snooze for" :items="SNOOZE_OPTIONS" @select="snoozeIssue">
							<template #trigger="{ props: menuProps }">
								<UiButton v-bind="menuProps" :icon="Clock">Snooze</UiButton>
							</template>
						</UiMenu>
						<UiButton v-else :icon="Clock" @click="unsnoozeIssue()">Unsnooze</UiButton>
					</div>
					<!-- Export stays in the header on phones too (the bottom bar holds triage) -->
					<UiMenu label="Export" title="Export issue" :items="EXPORT_OPTIONS" :width="240" @select="exportIssue">
						<template #trigger="{ props: menuProps }">
							<UiButton v-bind="menuProps" :icon="FileJson" data-testid="issue-export">Export</UiButton>
						</template>
					</UiMenu>
				</div>
			</header>

			<!-- Numbers -->
			<dl class="grid grid-cols-2 overflow-hidden rounded-[10px] border border-border bg-surface sm:grid-cols-4" data-numeric>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-b sm:border-r">
					<dt class="text-caption text-fg-subtle">Events</dt>
					<dd class="text-heading-m text-fg">{{ issue.count.toLocaleString() }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-b max-sm:border-l sm:border-r">
					<dt class="text-caption text-fg-subtle">Users</dt>
					<dd class="text-heading-m text-fg">{{ issue.userCount.toLocaleString() }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 sm:border-r">
					<dt class="text-caption text-fg-subtle">First seen</dt>
					<dd class="text-heading-m text-fg" :title="formatTime(issue.firstSeen)">{{ timeAgo(issue.firstSeen) }}</dd>
				</div>
				<div class="flex flex-col gap-1 border-border px-4 py-3 max-sm:border-l">
					<dt class="text-caption text-fg-subtle">Last seen</dt>
					<dd class="text-heading-m text-fg" :title="formatTime(issue.lastSeen)">{{ timeAgo(issue.lastSeen) }}</dd>
				</div>
			</dl>

			<!-- Snooze banner -->
			<UiAlert v-if="isSnoozed" tone="warning" action-label="Unsnooze" @action="unsnoozeIssue()">
				Snoozed until {{ formatTime(issue.snoozedUntil!) }}
			</UiAlert>

			<!-- Event selector -->
			<div v-if="events.length > 1" class="flex flex-wrap items-end gap-3">
				<UiFormField v-slot="f" label="Event" id="event-select">
					<UiSelect :id="f.id" v-model="selectedEventId" class="w-full sm:w-80">
						<option v-for="event in events" :key="event.event_id" :value="event.event_id">
							{{ formatTime(event.timestamp) }}{{ event.environment ? ` — ${event.environment}` : '' }}
						</option>
					</UiSelect>
				</UiFormField>
				<span class="pb-2.5 text-caption text-fg-subtle">{{ selectedIndex + 1 }} of {{ events.length }} loaded</span>
			</div>

			<!-- Event details -->
			<div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
				<div class="flex min-w-0 flex-col gap-5">
					<!-- Message (full, rendered as markdown; the title above carries only its first 80 chars) -->
					<UiCard v-if="renderedMessage" title="Message" data-testid="issue-message">
						<UiMarkdown :html="renderedMessage" class="px-4 py-3.5" />
					</UiCard>

					<!-- Stack trace -->
					<UiCard title="Stack Trace">
						<template #actions>
							<UiSegmented
								v-if="anyMapped"
								v-model="sourceView"
								label="Source"
								:options="[
									{ value: 'original', label: 'Original' },
									{ value: 'minified', label: 'Minified' },
								]"
							/>
							<span v-else-if="resolving" class="text-caption text-fg-subtle" aria-live="polite">Resolving source maps…</span>
						</template>
						<p v-if="getStackFrames().length === 0" class="px-4 py-4 text-body-s text-fg-muted">No stack trace available</p>
						<div v-else>
							<AppStackFrame
								v-for="(frame, index) in getStackFrames()"
								:key="index"
								:frame="frame"
								:resolved="resolvedFrames.get(index)"
								:show-original="showOriginal"
								:expanded="expandedFrames.has(index)"
								@toggle="toggleFrame(index)"
							/>
						</div>
					</UiCard>

					<!-- Attachments (per selected event) -->
					<AttachmentList v-if="selectedEvent.event_id" :slug="slug" :event-id="selectedEvent.event_id" />

					<!-- Breadcrumbs -->
					<UiCard
						v-if="selectedEvent.breadcrumbs?.length"
						title="Breadcrumbs"
						:meta="`${selectedEvent.breadcrumbs.length} entries`"
					>
						<ol class="max-h-96 overflow-y-auto">
							<li
								v-for="(crumb, index) in selectedEvent.breadcrumbs"
								:key="index"
								class="flex items-center gap-3 border-b border-border px-4 py-2.5 text-body-s last:border-b-0"
							>
								<span
									class="size-1.5 shrink-0 rounded-full"
									:class="{
										'bg-level-error': crumb.level === 'error' || crumb.level === 'fatal',
										'bg-level-warning': crumb.level === 'warning',
										'bg-level-debug': crumb.level === 'debug',
										'bg-level-info': !crumb.level || crumb.level === 'info',
									}"
									aria-hidden="true"
								/>
								<span v-if="crumb.timestamp" class="shrink-0 font-mono text-caption text-fg-subtle">
									{{ new Date(crumb.timestamp).toLocaleTimeString() }}
								</span>
								<span class="w-24 shrink-0 truncate text-caption text-fg-muted">{{ crumb.category || crumb.type || 'default' }}</span>
								<span class="min-w-0 flex-1 break-words text-fg">{{ crumb.message }}</span>
							</li>
						</ol>
					</UiCard>

					<!-- Activity -->
					<UiCard title="Activity">
						<form class="flex flex-col gap-2 border-b border-border p-4" @submit.prevent="addComment">
							<label for="new-comment" class="sr-only">Comment</label>
							<UiInput
								id="new-comment"
								v-model="newComment"
								multiline
								rows="3"
								placeholder="Leave a comment… (Markdown, ⌘↵ to post)"
								:disabled="submittingComment"
								@keydown.meta.enter="addComment"
								@keydown.ctrl.enter="addComment"
							/>
							<div class="flex justify-end">
								<UiButton type="submit" variant="primary" size="sm" :loading="submittingComment" :disabled="!newComment.trim()">
									{{ submittingComment ? 'Posting...' : 'Comment' }}
								</UiButton>
							</div>
						</form>

						<p v-if="activity.length === 0" class="px-4 py-4 text-body-s text-fg-muted">No activity yet</p>
						<ol v-else>
							<li v-for="entry in activity" :key="entry.id" class="flex gap-3 border-b border-border px-4 py-3 text-body-s last:border-b-0">
								<UiAvatar :name="entry.userName" size="sm" />
								<div class="min-w-0 flex-1">
									<!-- Status change -->
									<p v-if="entry.type === 'status_change'" class="text-fg-muted">
										<span class="font-medium text-fg">{{ entry.userName }}</span>
										changed status from
										<span class="font-medium text-fg">{{ entry.data.from }}</span>
										to
										<span class="font-medium text-fg">{{ entry.data.to }}</span>
										<span class="ml-1 text-caption text-fg-subtle">{{ formatTime(entry.createdAt) }}</span>
									</p>
									<!-- Comment -->
									<template v-else-if="entry.type === 'comment'">
										<div class="flex items-center gap-2">
											<span class="font-medium text-fg">{{ entry.userName }}</span>
											<span class="text-caption text-fg-subtle">{{ formatTime(entry.createdAt) }}</span>
											<span class="flex-1" />
											<UiButton
												v-if="authStore.user && entry.userId === authStore.user.id"
												size="icon-sm"
												variant="ghost"
												:icon="Trash2"
												:aria-label="`Delete comment from ${formatTime(entry.createdAt)}`"
												@click="deleteComment(entry.data.commentId)"
											/>
										</div>
										<p class="mt-1 whitespace-pre-wrap text-fg">{{ entry.data.body }}</p>
									</template>
								</div>
							</li>
						</ol>
					</UiCard>
				</div>

				<!-- Side column -->
				<aside class="flex min-w-0 flex-col gap-5" aria-label="Event context">
					<UiCard title="Event Info" :heading-level="3">
						<UiDescriptionList :items="eventInfo" />
					</UiCard>
					<UiCard v-if="userInfo.length" title="User" :heading-level="3">
						<UiDescriptionList :items="userInfo" />
					</UiCard>
					<UiCard v-if="selectedEvent.tags && Object.keys(selectedEvent.tags).length > 0" title="Tags" :heading-level="3">
						<div class="flex flex-wrap gap-1.5 px-4 py-3.5">
							<UiTag v-for="(value, key) in selectedEvent.tags" :key="key">
								<span class="text-fg-subtle">{{ key }}:</span>{{ value }}
							</UiTag>
						</div>
					</UiCard>
				</aside>
			</div>

			<!-- Phones: actions in a fixed bottom bar -->
			<div
				class="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-border bg-raised px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:hidden"
				data-testid="issue-mobile-actions"
			>
				<UiButton v-if="issue.status !== 'resolved'" variant="primary" class="flex-1" :icon="Check" @click="updateStatus('resolved')">Resolve</UiButton>
				<UiButton v-else class="flex-1" :icon="Eye" @click="updateStatus('unresolved')">Reopen</UiButton>
				<UiButton v-if="issue.status !== 'ignored'" class="flex-1" :icon="EyeOff" @click="updateStatus('ignored')">Ignore</UiButton>
				<UiMenu v-if="!isSnoozed" label="Snooze" title="Snooze for" placement="top" :items="SNOOZE_OPTIONS" @select="snoozeIssue">
					<template #trigger="{ props: menuProps }">
						<UiButton v-bind="menuProps" :icon="Clock">Snooze</UiButton>
					</template>
				</UiMenu>
				<UiButton v-else :icon="Clock" @click="unsnoozeIssue()">Unsnooze</UiButton>
			</div>
		</div>
	</div>
</template>
