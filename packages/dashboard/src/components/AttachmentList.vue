<script setup lang="ts">
import { Download, Eye, EyeOff, Paperclip } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import { useToast } from '../composables/useToast';
import {
	type AttachmentMeta,
	classifyAttachment,
	downloadAttachment,
	formatBytes,
	loadAttachmentPreview,
} from '../lib/attachments';
import { UiAlert, UiButton, UiCard, UiSkeleton, UiTag } from './ui';

const toast = useToast();
const props = defineProps<{
	slug: string;
	eventId: string;
}>();

interface PreviewState {
	status: 'loading' | 'ready' | 'none' | 'error';
	kind?: 'text' | 'image';
	text?: string;
	url?: string;
	truncated?: boolean;
	message?: string;
}

const attachments = ref<AttachmentMeta[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const previews = ref<Record<string, PreviewState>>({});
const downloading = ref<Record<string, boolean>>({});
/** Live object URLs by attachment id, revoked on collapse/scope change. */
const liveUrls = new Map<string, string>();
/**
 * Monotonic generation: async results commit only if their generation is
 * still current, so switching events (or unmounting) mid-flight can never
 * land stale lists/previews on the new scope.
 */
let generation = 0;

function revokeUrl(attachmentId: string): void {
	const url = liveUrls.get(attachmentId);
	if (url !== undefined) {
		liveUrls.delete(attachmentId);
		URL.revokeObjectURL(url);
	}
}

function revokeAllUrls(): void {
	for (const url of liveUrls.values()) URL.revokeObjectURL(url);
	liveUrls.clear();
}

async function load(): Promise<void> {
	const run = ++generation;
	loading.value = true;
	error.value = null;
	revokeAllUrls();
	previews.value = {};
	downloading.value = {};
	try {
		const response = await api.get<{ attachments: AttachmentMeta[] }>(
			`/api/projects/${props.slug}/events/${props.eventId}/attachments`,
		);
		if (run !== generation) return;
		attachments.value = response.attachments ?? [];
	} catch (err) {
		if (run !== generation) return;
		error.value = err instanceof Error ? err.message : 'Failed to load attachments';
	} finally {
		if (run === generation) loading.value = false;
	}
}

async function togglePreview(attachment: AttachmentMeta): Promise<void> {
	const current = previews.value[attachment.id];
	if (current) {
		// collapse: release the image blob immediately (no leak on re-toggle)
		revokeUrl(attachment.id);
		delete previews.value[attachment.id];
		return;
	}
	const run = generation;
	previews.value[attachment.id] = { status: 'loading' };
	try {
		const preview = await loadAttachmentPreview(props.slug, attachment);
		if (run !== generation) {
			if (preview.kind === 'image') URL.revokeObjectURL(preview.url);
			return;
		}
		if (preview.kind === 'refused') {
			previews.value[attachment.id] = { status: 'none', message: preview.reason };
			return;
		}
		if (preview.kind === 'image') {
			liveUrls.set(attachment.id, preview.url);
			previews.value[attachment.id] = {
				status: 'ready',
				kind: 'image',
				url: preview.url,
			};
		} else {
			previews.value[attachment.id] = {
				status: 'ready',
				kind: 'text',
				text: preview.text,
				truncated: preview.truncated,
			};
		}
	} catch (err) {
		if (run !== generation) return;
		previews.value[attachment.id] = {
			status: 'error',
			message: err instanceof Error ? err.message : 'Preview failed',
		};
	}
}

async function download(attachment: AttachmentMeta): Promise<void> {
	if (downloading.value[attachment.id]) return;
	const run = generation;
	downloading.value[attachment.id] = true;
	try {
		await downloadAttachment(props.slug, attachment);
	} catch (err) {
		// A failed download should not hide the list: report it and move on.
		if (run === generation) {
			toast.error(`Download failed: ${err instanceof Error ? err.message : 'unknown error'}`);
		}
	} finally {
		if (run === generation) downloading.value[attachment.id] = false;
	}
}

function compressionBadge(filename: string): string | null {
	const cls = classifyAttachment(filename);
	return cls.compression ? cls.compression.toUpperCase() : null;
}

onMounted(() => load());
watch(
	() => [props.slug, props.eventId],
	() => {
		generation++; // invalidate in-flight loads/previews for the old scope
		revokeAllUrls();
		load();
	},
);
onBeforeUnmount(() => {
	generation++;
	revokeAllUrls();
});
</script>

<template>
	<UiCard title="Attachments" :meta="attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'}` : undefined">
		<UiSkeleton v-if="loading" variant="line" :count="2" label="Loading attachments" class="p-4" />
		<UiAlert v-else-if="error" tone="error" action-label="Try again" class="m-4" @action="load">{{ error }}</UiAlert>
		<p v-else-if="attachments.length === 0" class="flex items-center gap-2 px-4 py-4 text-body-s text-fg-muted">
			<Paperclip :size="14" class="text-fg-subtle" aria-hidden="true" />
			No attachments on this event.
		</p>

		<ul v-else>
			<li v-for="attachment in attachments" :key="attachment.id" class="border-b border-border last:border-b-0">
				<div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
					<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<span class="min-w-0 truncate font-mono text-body-s text-fg">{{ attachment.filename }}</span>
						<UiTag v-if="compressionBadge(attachment.filename)">
							{{ compressionBadge(attachment.filename) }} → auto-decompressed
						</UiTag>
						<UiTag>{{ attachment.contentType }}</UiTag>
						<span class="text-caption text-fg-subtle" data-numeric>{{ formatBytes(attachment.size) }}</span>
					</div>
					<div class="flex shrink-0 items-center gap-1.5">
						<UiButton
							size="sm"
							:icon="previews[attachment.id]?.status === 'ready' ? EyeOff : Eye"
							:loading="previews[attachment.id]?.status === 'loading'"
							:aria-expanded="previews[attachment.id]?.status === 'ready'"
							@click="togglePreview(attachment)"
						>
							{{
								previews[attachment.id]?.status === 'ready'
									? 'Hide'
									: previews[attachment.id]?.status === 'loading'
										? 'Loading…'
										: 'Preview'
							}}
						</UiButton>
						<UiButton
							size="sm"
							:icon="Download"
							:loading="downloading[attachment.id]"
							@click="download(attachment)"
						>
							{{ downloading[attachment.id] ? 'Downloading…' : 'Download' }}
						</UiButton>
					</div>
				</div>

				<div
					v-if="previews[attachment.id] && previews[attachment.id].status !== 'loading'"
					class="border-t border-border bg-canvas px-4 py-3"
				>
					<p v-if="previews[attachment.id].status === 'none'" class="text-caption text-fg-muted">
						{{ previews[attachment.id].message }}
					</p>
					<p v-else-if="previews[attachment.id].status === 'error'" class="text-caption text-level-error" role="alert">
						{{ previews[attachment.id].message }}
					</p>
					<template v-else-if="previews[attachment.id].status === 'ready'">
						<img
							v-if="previews[attachment.id].kind === 'image'"
							:src="previews[attachment.id].url"
							:alt="`Preview of ${attachment.filename}`"
							class="max-h-96 rounded-md"
						/>
						<pre
							v-else
							class="max-h-96 overflow-auto font-mono text-caption leading-5 whitespace-pre-wrap text-fg"
						>{{ previews[attachment.id].text }}</pre>
						<p v-if="previews[attachment.id].truncated" class="mt-2 text-caption text-level-warning">
							Preview truncated at {{ formatBytes(2 * 1024 * 1024) }} — download for the full file.
						</p>
					</template>
				</div>
			</li>
		</ul>
	</UiCard>
</template>
