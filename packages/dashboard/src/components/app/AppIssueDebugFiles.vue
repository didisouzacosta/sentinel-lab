<script setup lang="ts">
import { ArrowUpRight } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { api } from '../../api/client';
import { type DebugFileKind, FILE_NOUN, platformOf, uploadLink } from '../../lib/debug-files';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiCode from '../ui/UiCode.vue';
import AppDebugImageRow from './AppDebugImageRow.vue';

/**
 * The issue's Debug files card: the images the selected event needs (its
 * in-app code, its mappings) and whether each file is stored, with the way
 * to upload what is missing. System libraries are only counted.
 */
const props = defineProps<{ slug: string; issueId: string; eventId: string }>();

interface CheckImage {
	debugId: string;
	kind: DebugFileKind | null;
	codeFile: string | null;
	arch: string | null;
	status: 'found' | 'missing' | 'processing';
	needed: boolean;
}

const images = ref<CheckImage[]>([]);
const loaded = ref(false);

watch(
	() => props.eventId,
	async (eventId) => {
		loaded.value = false;
		try {
			const data = await api.post<{ images: CheckImage[] }>(
				`/api/projects/${props.slug}/debug-files/check`,
				{
					eventId,
				},
			);
			images.value = data.images;
		} catch {
			images.value = [];
		} finally {
			loaded.value = true;
		}
	},
	{ immediate: true },
);

const needed = computed(() => images.value.filter((image) => image.needed));
const others = computed(() => images.value.length - needed.value.length);
const missing = computed(() => needed.value.filter((image) => image.status === 'missing'));
const firstMissing = computed(() => missing.value[0] ?? null);
const platform = computed(() =>
	platformOf(firstMissing.value?.kind ?? needed.value[0]?.kind ?? null),
);
const meta = computed(() => {
	if (needed.value.length === 0)
		return `${images.value.length} system image${images.value.length === 1 ? '' : 's'}`;
	const found = needed.value.length - missing.value.length;
	return `${found} of ${needed.value.length} needed found`;
});
const imageName = (image: CheckImage) =>
	image.codeFile?.split('/').pop() || (image.kind === 'proguard' ? 'ProGuard mapping' : 'Image');
const command = computed(() =>
	platform.value === 'android'
		? `sentry-cli upload-proguard --uuid ${firstMissing.value?.debugId ?? '<UUID>'} app/build/outputs/mapping/release/mapping.txt`
		: 'sentry-cli debug-files upload --wait MyApp.xcarchive/dSYMs',
);
</script>

<template>
	<UiCard v-if="loaded && images.length > 0" title="Debug files" :meta="meta" data-testid="issue-debug-files">
		<ul v-if="needed.length > 0">
			<AppDebugImageRow
				v-for="image in needed"
				:key="`${image.kind}:${image.debugId}`"
				:image="imageName(image)"
				:debug-id="image.debugId"
				:arch="image.arch"
				:status="image.status"
			/>
		</ul>
		<p v-if="others > 0" class="border-b border-border px-4 py-2.5 text-caption text-fg-subtle">
			{{ others }} system librar{{ others === 1 ? 'y' : 'ies' }} without debug files — not needed to read this crash.
		</p>
		<div v-if="firstMissing" class="flex flex-col gap-2.5 px-4 py-3.5">
			<p class="text-body-s text-fg-muted">
				Upload this build’s {{ FILE_NOUN[platform] }} and its crashes are symbolicated again automatically,
				including the ones already here.
			</p>
			<div>
				<UiButton
					variant="primary"
					:icon="ArrowUpRight"
					:to="uploadLink(slug, { kind: firstMissing.kind ?? 'macho', debugId: firstMissing.debugId }, issueId)"
				>
					Upload {{ FILE_NOUN[platform] }}
				</UiButton>
			</div>
			<UiCode :code="command" language="Terminal" />
		</div>
	</UiCard>
</template>
