<script setup lang="ts">
import { Upload } from 'lucide-vue-next';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, api } from '../../api/client';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import { type DebugFileKind, type DebugPlatform, FILE_NOUN } from '../../lib/debug-files';
import UiAlert from '../ui/UiAlert.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiFormField from '../ui/UiFormField.vue';
import UiInput from '../ui/UiInput.vue';
import UiTabs from '../ui/UiTabs.vue';
import AppDebugFileHint from './AppDebugFileHint.vue';
import AppFileRow from './AppFileRow.vue';

/**
 * Project settings → Debug files: one tab per platform (iOS dSYMs, Android
 * ProGuard/R8 mappings), each with how to get the file, the upload and the
 * stored files. A crash missing its file links here with `?debugFiles=`,
 * `debugId` and `issue`, which opens the right tab and names the file.
 */
const props = defineProps<{ slug: string; canManage: boolean }>();

interface DebugFile {
	id: string;
	debugId: string;
	kind: DebugFileKind;
	arch: string | null;
	name: string;
	size: number;
	createdAt: string;
}

const route = useRoute();
const toast = useToast();
const askConfirm = useConfirm();

const tab = ref<DebugPlatform>(route.query.debugFiles === 'android' ? 'android' : 'ios');
const files = ref<DebugFile[]>([]);
const loading = ref(true);
// shallowRef: a deep ref would wrap the File in a Proxy, which fetch refuses as a body.
const file = shallowRef<File | null>(null);
const mappingUuid = ref('');
const uploading = ref(false);
const error = ref('');
const input = ref<HTMLInputElement | null>(null);

/** The file a crash asked for, when the user arrived from an issue. */
const wanted = computed(() => {
	const debugId = typeof route.query.debugId === 'string' ? route.query.debugId : '';
	const platform = route.query.debugFiles === 'android' ? 'android' : 'ios';
	if (!debugId) return null;
	const issue = typeof route.query.issue === 'string' ? route.query.issue : null;
	const stored = files.value.some((f) => f.debugId === debugId.toLowerCase());
	return { debugId: debugId.toLowerCase(), platform, issue, stored };
});

const kindOf = (platform: DebugPlatform): DebugFileKind =>
	platform === 'android' ? 'proguard' : 'macho';
const ofTab = computed(() => files.value.filter((f) => f.kind === kindOf(tab.value)));
const tabs = computed(() => [
	{
		value: 'ios' as const,
		label: 'iOS · dSYMs',
		count: files.value.filter((f) => f.kind === 'macho').length,
	},
	{
		value: 'android' as const,
		label: 'Android · ProGuard/R8',
		count: files.value.filter((f) => f.kind === 'proguard').length,
	},
]);

async function load() {
	loading.value = true;
	try {
		const data = await api.get<{ debugFiles: DebugFile[] }>(
			`/api/projects/${props.slug}/debug-files?limit=200`,
		);
		files.value = data.debugFiles;
	} catch {
		files.value = [];
	} finally {
		loading.value = false;
	}
}

function choose(event: Event) {
	const target = event.target as HTMLInputElement;
	file.value = target.files?.[0] ?? null;
	error.value = '';
}

watch(tab, () => {
	file.value = null;
	error.value = '';
	if (input.value) input.value.value = '';
});

// Arriving for a mapping pre-fills its UUID.
watch(
	wanted,
	(value) => {
		if (value && value.platform === 'android' && !mappingUuid.value)
			mappingUuid.value = value.debugId;
	},
	{ immediate: true },
);

async function upload() {
	if (!file.value) return;
	uploading.value = true;
	error.value = '';
	const params = new URLSearchParams({
		kind: tab.value === 'android' ? 'proguard' : 'dsym',
		name: file.value.name.slice(0, 200),
	});
	if (tab.value === 'android' && mappingUuid.value.trim())
		params.set('debugId', mappingUuid.value.trim());
	try {
		const result = await api.upload<{ debugFiles: DebugFile[]; reprocessing?: number }>(
			`/api/projects/${props.slug}/debug-files?${params}`,
			file.value,
		);
		const noun = FILE_NOUN[tab.value];
		const reprocessing = result.reprocessing ?? 0;
		toast.success(
			reprocessing > 0
				? `${noun} uploaded. Reprocessing ${reprocessing} issue${reprocessing === 1 ? '' : 's'} that needed it.`
				: `${noun} uploaded.`,
		);
		file.value = null;
		if (input.value) input.value.value = '';
		await load();
	} catch (e) {
		error.value =
			e instanceof ApiError && e.code === 'not_debug_file'
				? 'This is the app binary, not its dSYM. Pick the file inside MyApp.app.dSYM/Contents/Resources/DWARF/.'
				: e instanceof Error
					? e.message
					: 'Upload failed';
	} finally {
		uploading.value = false;
	}
}

async function remove(f: DebugFile) {
	const ok = await askConfirm({
		title: `Delete ${f.name}?`,
		description:
			'Crashes from builds that need it will show addresses again until it is uploaded again.',
		confirmLabel: 'Delete',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/projects/${props.slug}/debug-files/${f.id}`);
		files.value = files.value.filter((x) => x.id !== f.id);
		toast.success('Debug file deleted');
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Could not delete the debug file');
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
	return new Date(value).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

onMounted(load);
</script>

<template>
	<UiCard id="debug-files" title="Debug files" meta="Files that turn native crashes back into code" class="scroll-mt-20">
		<div class="px-4 pt-1">
			<UiTabs v-model="tab" :items="tabs" label="Debug file platform" />
		</div>
		<div class="flex flex-col gap-3 p-4">
			<UiAlert
				v-if="wanted && wanted.platform === tab && !wanted.stored"
				tone="warning"
				:action-label="wanted.issue ? 'View issue' : undefined"
				data-testid="debug-file-wanted"
				@action="$router.push({ name: 'issue-detail', params: { slug, issueId: wanted.issue } })"
			>
				A crash needs {{ tab === 'android' ? 'mapping' : 'dSYM' }}
				<span class="font-mono break-all">{{ wanted.debugId }}</span>. Upload it here.
			</UiAlert>

			<AppDebugFileHint :key="tab" :platform="tab" />

			<form class="flex flex-col gap-3" @submit.prevent="upload">
				<UiFormField
					v-if="tab === 'android'"
					v-slot="f"
					label="Mapping UUID"
					help="From io.sentry.ProguardUuids in sentry-debug-meta.properties. Leave empty to derive it from the file, like sentry-cli."
				>
					<UiInput
						:id="f.id"
						v-model="mappingUuid"
						placeholder="11111111-2222-3333-4444-555555555555"
						class="font-mono"
						autocomplete="off"
						spellcheck="false"
					/>
				</UiFormField>
				<div class="flex flex-wrap items-center gap-2">
					<input
						ref="input"
						type="file"
						class="sr-only"
						:accept="tab === 'android' ? '.txt,text/plain' : undefined"
						:aria-label="tab === 'android' ? 'ProGuard/R8 mapping file' : 'dSYM DWARF file'"
						data-testid="debug-file-input"
						@change="choose"
					/>
					<UiButton :icon="Upload" @click="input?.click()">
						{{ tab === 'android' ? 'Choose mapping.txt' : 'Choose dSYM file' }}
					</UiButton>
					<span class="min-w-0 truncate text-caption text-fg-subtle">
						{{ file ? `${file.name} · ${formatSize(file.size)}` : 'No file chosen' }}
					</span>
				</div>
				<UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
				<div>
					<UiButton type="submit" variant="primary" :loading="uploading" :disabled="!file">
						{{ tab === 'android' ? 'Upload mapping' : 'Upload dSYM' }}
					</UiButton>
				</div>
			</form>

			<ul
				v-if="ofTab.length > 0"
				class="overflow-hidden rounded-lg border border-border"
				:aria-label="tab === 'android' ? 'Uploaded mappings' : 'Uploaded dSYMs'"
			>
				<AppFileRow
					v-for="f in ofTab"
					:key="f.id"
					:tag="f.kind === 'proguard' ? 'ProGuard' : 'dSYM'"
					:name="`${f.name} · ${f.debugId}`"
					:meta="[f.arch, formatSize(f.size), formatDate(f.createdAt)].filter(Boolean).join(' · ')"
					:delete-label="canManage ? `Delete ${f.name} ${f.debugId}` : undefined"
					test-id="debug-file-row"
					@delete="remove(f)"
				/>
			</ul>
			<p v-else-if="!loading" class="text-body-s text-fg-subtle">
				{{ tab === 'android' ? 'No mappings uploaded yet.' : 'No dSYMs uploaded yet.' }}
			</p>
		</div>
	</UiCard>
</template>
