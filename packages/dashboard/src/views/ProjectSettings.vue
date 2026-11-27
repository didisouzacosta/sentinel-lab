<script setup lang="ts">
import { Funnel, KeyRound, Plug, Trash2, Upload } from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import AppDebugFilesSettings from '../components/app/AppDebugFilesSettings.vue';
import AppFileRow from '../components/app/AppFileRow.vue';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import AppSectionNav, { type SectionNavItem } from '../components/app/AppSectionNav.vue';
import {
	UiAlert,
	UiAvatar,
	UiButton,
	UiCard,
	UiCopyField,
	UiDescriptionList,
	UiFormField,
	UiInput,
	UiSelect,
	UiSkeleton,
	UiTag,
} from '../components/ui';
import UiMeter from '../components/ui/UiMeter.vue';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { formatNumber } from '../lib/format';
import { useProjectsStore } from '../stores/projects';

interface Project {
	id: string;
	name: string;
	slug: string;
	platform: string;
	publicKey: string;
	webhookUrl?: string | null;
	createdAt: string;
}

interface ProjectMember {
	userId: string;
	email: string;
	name: string;
	role: 'owner' | 'admin' | 'member';
	createdAt: string;
}

interface SourceMap {
	id: string;
	release: string;
	fileUrl: string;
	createdAt: string;
	size: number;
}

const route = useRoute();
const router = useRouter();
const projectsStore = useProjectsStore();
const toast = useToast();
const askConfirm = useConfirm();
const slug = computed(() => route.params.slug as string);
// Deleting source maps is for project owners and admins (the server enforces it).
const canDeleteSourceMaps = computed(() => projectsStore.canManage(slug.value));

const canManage = computed(() => projectsStore.canManage(slug.value));

const ALL_SECTIONS: (SectionNavItem & { managersOnly?: boolean })[] = [
	{ id: 'dsn', label: 'Client keys (DSN)' },
	{ id: 'information', label: 'Project information' },
	{ id: 'members', label: 'Team members' },
	{ id: 'integrations', label: 'Integrations' },
	{ id: 'rate-limit', label: 'Rate limiting' },
	{ id: 'retention', label: 'Data retention' },
	{ id: 'api-tokens', label: 'API tokens' },
	{ id: 'source-maps', label: 'Source maps' },
	{ id: 'debug-files', label: 'Debug files' },
	{ id: 'symbolication', label: 'Symbolication' },
	{ id: 'inbound-filters', label: 'Inbound filters' },
	{ id: 'danger', label: 'Danger zone', danger: true },
];
const SECTIONS = computed<SectionNavItem[]>(() =>
	ALL_SECTIONS.filter((section) => !section.managersOnly || canManage.value).map(
		({ managersOnly: _managersOnly, ...section }) => section,
	),
);

const RETENTION_OPTIONS = [
	{ value: 0, label: 'Keep forever' },
	{ value: 7, label: '7 days' },
	{ value: 30, label: '30 days' },
	{ value: 90, label: '90 days' },
	{ value: 180, label: '180 days' },
	{ value: 365, label: '1 year' },
];

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

const project = ref<Project | null>(null);
const dsn = ref('');
const loading = ref(true);
const loadError = ref<string | null>(null);

const maxEventsPerHour = ref(0);
const rateLimitStatus = ref<{ currentHourCount: number; isLimited: boolean } | null>(null);
const savingRateLimit = ref(false);

const retentionDays = ref(0);
const maxSymbolicationsPerHour = ref(500);
const symbolicationsThisHour = ref(0);
const savingSymbolication = ref(false);
const savingRetention = ref(false);

const sourceMaps = ref<SourceMap[]>([]);
const smRelease = ref('');
const smFileUrl = ref('');
const smContent = ref('');
const smFile = ref<{ name: string; size: number } | null>(null);
const smInput = ref<HTMLInputElement | null>(null);
const uploadingSm = ref(false);
const smError = ref<string | null>(null);

// Read-only roster — membership is administered centrally under /admin/projects.
const members = ref<ProjectMember[]>([]);
const membersLoading = ref(false);
const membersError = ref<string | null>(null);

const projectInfo = computed(() =>
	project.value
		? [
				{ label: 'Name', value: project.value.name },
				{ label: 'Slug', value: project.value.slug, mono: true },
				{ label: 'Platform', value: project.value.platform },
				{ label: 'Created', value: formatDate(project.value.createdAt) },
				{ label: 'Project ID', value: project.value.id, mono: true },
			]
		: [],
);

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

async function loadProject() {
	loading.value = true;
	loadError.value = null;
	try {
		const response = await api.get<{ project: Project; dsn: string }>(
			`/api/projects/${slug.value}`,
		);
		project.value = response.project;
		dsn.value = response.dsn;

		const settings = await api.get<{
			retentionDays: number;
			maxSymbolicationsPerHour?: number;
			symbolicationsThisHour?: number;
		}>(`/api/projects/${slug.value}/settings`);
		retentionDays.value = settings.retentionDays;
		maxSymbolicationsPerHour.value = settings.maxSymbolicationsPerHour ?? 500;
		symbolicationsThisHour.value = settings.symbolicationsThisHour ?? 0;
		loadSourceMaps();
	} catch (err) {
		loadError.value = message(err, 'Failed to load project');
	} finally {
		loading.value = false;
	}
}

async function loadSourceMaps() {
	try {
		const response = await api.get<{ sourceMaps: SourceMap[] }>(
			`/api/projects/${slug.value}/sourcemaps`,
		);
		sourceMaps.value = response.sourceMaps;
	} catch {
		// Non-critical — the list just stays empty.
	}
}

async function loadMembers() {
	membersLoading.value = true;
	membersError.value = null;
	try {
		const response = await api.get<{ members: ProjectMember[] }>(
			`/api/projects/${slug.value}/members`,
		);
		members.value = response.members;
	} catch (err) {
		membersError.value = message(err, 'Failed to load members');
	} finally {
		membersLoading.value = false;
	}
}

async function loadRateLimitStatus() {
	try {
		const response = await api.get<{
			maxEventsPerHour: number;
			currentHourCount: number;
			isLimited: boolean;
		}>(`/api/projects/${slug.value}/rate-limit`);
		maxEventsPerHour.value = response.maxEventsPerHour;
		rateLimitStatus.value = response;
	} catch {
		/* the usage line is optional */
	}
}

async function saveRateLimit() {
	savingRateLimit.value = true;
	try {
		await api.patch(`/api/projects/${slug.value}`, { maxEventsPerHour: maxEventsPerHour.value });
		toast.success('Rate limit saved');
		await loadRateLimitStatus();
	} catch (err) {
		toast.error(message(err, 'Failed to save'));
	} finally {
		savingRateLimit.value = false;
	}
}

async function saveSymbolication() {
	savingSymbolication.value = true;
	try {
		await api.patch(`/api/projects/${slug.value}`, {
			maxSymbolicationsPerHour: maxSymbolicationsPerHour.value,
		});
		toast.success('Symbolication budget saved');
	} catch (err) {
		toast.error(message(err, 'Failed to save'));
	} finally {
		savingSymbolication.value = false;
	}
}

async function saveRetention() {
	savingRetention.value = true;
	try {
		await api.patch(`/api/projects/${slug.value}`, { retentionDays: retentionDays.value });
		toast.success('Retention saved');
	} catch (err) {
		toast.error(message(err, 'Failed to save settings'));
	} finally {
		savingRetention.value = false;
	}
}

function handleSourceMapFile(event: Event) {
	const file = (event.target as HTMLInputElement).files?.[0];
	if (!file) return;
	smFile.value = { name: file.name, size: file.size };
	const reader = new FileReader();
	reader.onload = () => {
		smContent.value = reader.result as string;
	};
	reader.readAsText(file);
}

async function uploadSourceMap() {
	uploadingSm.value = true;
	smError.value = null;
	try {
		await api.post(`/api/projects/${slug.value}/sourcemaps`, {
			release: smRelease.value,
			fileUrl: smFileUrl.value,
			content: smContent.value,
		});
		toast.success('Source map uploaded');
		smRelease.value = '';
		smFileUrl.value = '';
		smContent.value = '';
		smFile.value = null;
		if (smInput.value) smInput.value.value = '';
		loadSourceMaps();
	} catch (err) {
		smError.value = message(err, 'Upload failed');
	} finally {
		uploadingSm.value = false;
	}
}

async function deleteSourceMap(sm: SourceMap) {
	const ok = await askConfirm({
		title: 'Delete this source map?',
		description: 'Stack traces for this file will show minified code again.',
		items: [`${sm.release} · ${sm.fileUrl}`],
		confirmLabel: 'Delete source map',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/projects/${slug.value}/sourcemaps/${sm.id}`);
		sourceMaps.value = sourceMaps.value.filter((s) => s.id !== sm.id);
		toast.success('Source map deleted');
	} catch (err) {
		toast.error(message(err, 'Failed to delete source map'));
	}
}

async function deleteProject() {
	if (!project.value) return;
	const ok = await askConfirm({
		title: `Delete "${project.value.name}"?`,
		description:
			'This cannot be undone. All issues, events and settings of this project will be permanently deleted.',
		confirmLabel: 'Delete project',
		tone: 'danger',
		requireText: project.value.name,
	});
	if (!ok) return;
	try {
		await api.delete(`/api/projects/${slug.value}`);
		projectsStore.removeProject(slug.value); // so the sidebar updates
		toast.success(`Project "${project.value.name}" deleted`);
		router.push('/projects');
	} catch (err) {
		toast.error(message(err, 'Failed to delete project'));
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateString: string): string {
	return new Date(dateString).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

onMounted(async () => {
	loadRateLimitStatus();
	loadMembers();
	await loadProject();
	// A link to a section (#debug-files from a crash missing its dSYM)
	// arrives before the cards exist: scroll once they are rendered.
	if (route.hash) {
		await nextTick();
		document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start' });
	}
});
</script>

<template>
	<div class="mx-auto flex max-w-[960px] flex-col gap-5">
		<AppPageHeader title="Project settings" :subtitle="project?.name ?? slug" />

		<UiSkeleton v-if="loading" variant="block" :count="3" label="Loading project settings" />

		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="loadProject">
			{{ loadError }}
		</UiAlert>

		<div v-else-if="project" class="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-8">
			<AppSectionNav :items="SECTIONS" label="Settings sections" class="sticky top-20 max-lg:hidden" />

			<div class="flex flex-col gap-5">
				<UiCard id="dsn" title="Client keys (DSN)" class="scroll-mt-20" padded>
					<p class="mb-3 text-body-s text-fg-muted">Use this DSN to configure your Sentry SDK.</p>
					<UiCopyField :value="dsn" label="DSN" />
				</UiCard>

				<UiCard id="information" title="Project information" class="scroll-mt-20">
					<UiDescriptionList :items="projectInfo" layout="grid" />
				</UiCard>

				<UiCard
					id="members"
					title="Team members"
					:meta="members.length ? `${members.length}` : undefined"
					class="scroll-mt-20"
					data-testid="members-card"
				>
					<p class="px-4 pt-3.5 text-body-s text-fg-muted">
						Who has access to this project. Membership is managed centrally by administrators
						(Administration → Projects).
					</p>
					<div class="px-4 pt-3 pb-4">
						<UiAlert v-if="membersError" tone="error">{{ membersError }}</UiAlert>
						<UiSkeleton v-else-if="membersLoading && members.length === 0" :count="2" label="Loading members" />
						<p v-else-if="members.length === 0" class="text-body-s text-fg-subtle">No members found.</p>
						<ul v-else class="overflow-hidden rounded-lg border border-border">
							<li
								v-for="member in members"
								:key="member.userId"
								class="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
							>
								<UiAvatar :name="member.name" size="sm" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-body-s font-medium text-fg">{{ member.name }}</p>
									<p class="truncate text-caption text-fg-subtle">{{ member.email }}</p>
								</div>
								<UiTag :tone="member.role === 'owner' ? 'accent' : 'neutral'">{{ ROLE_LABELS[member.role] }}</UiTag>
							</li>
						</ul>
					</div>
				</UiCard>

				<UiCard id="integrations" title="Integrations" class="scroll-mt-20" padded>
					<div class="flex flex-wrap items-center gap-3">
						<p class="min-w-0 flex-1 text-body-s text-fg-muted">
							Slack, Kaneo and the webhook now have their own page, with a step-by-step setup and the status of
							each connection.
						</p>
						<UiButton :to="`/projects/${slug}/integrations`" :icon="Plug">Open integrations</UiButton>
					</div>
				</UiCard>

				<UiCard id="rate-limit" title="Rate limiting" meta="0 = unlimited" class="scroll-mt-20" padded>
					<form class="flex flex-wrap items-end gap-2" @submit.prevent="saveRateLimit">
						<UiFormField v-slot="f" label="Max events per hour" class="w-full sm:w-52">
							<UiInput
								:id="f.id"
								v-model.number="maxEventsPerHour"
								type="number"
								min="0"
								step="100"
								placeholder="0 (unlimited)"
								data-numeric
							/>
						</UiFormField>
						<UiButton type="submit" variant="primary" :loading="savingRateLimit">Save</UiButton>
					</form>
					<div
						v-if="rateLimitStatus && maxEventsPerHour > 0"
						class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2"
						data-testid="rate-limit-usage"
					>
						<span class="text-body-s text-fg-subtle">Current hour</span>
						<span
							class="text-body-s font-medium"
							:class="rateLimitStatus.isLimited ? 'text-level-error' : 'text-fg'"
							data-numeric
						>
							{{ formatNumber(rateLimitStatus.currentHourCount) }} / {{ formatNumber(maxEventsPerHour) }}
						</span>
						<UiMeter :value="rateLimitStatus.currentHourCount" :max="maxEventsPerHour" label="Events this hour" />
						<UiTag v-if="rateLimitStatus.isLimited" class="text-level-error">Rate limited</UiTag>
					</div>
				</UiCard>

				<UiCard
					id="retention"
					title="Data retention"
					meta="Older events are deleted automatically"
					class="scroll-mt-20"
					padded
				>
					<form class="flex flex-wrap items-end gap-2" @submit.prevent="saveRetention">
						<UiFormField v-slot="f" label="Keep events for" class="w-full sm:w-52">
							<UiSelect :id="f.id" v-model.number="retentionDays" class="w-full">
								<option v-for="o in RETENTION_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
							</UiSelect>
						</UiFormField>
						<UiButton type="submit" variant="primary" :loading="savingRetention">Save</UiButton>
					</form>
				</UiCard>

				<UiCard
					id="api-tokens"
					title="API tokens"
					meta="Personal tokens for the API and AI agents"
					class="scroll-mt-20"
					padded
				>
					<UiButton :icon="KeyRound" to="/settings/tokens">Manage API tokens</UiButton>
				</UiCard>

				<UiCard
					id="source-maps"
					title="Source maps"
					meta="Original code in stack traces"
					class="scroll-mt-20"
					padded
				>
					<form class="flex flex-col gap-3" @submit.prevent="uploadSourceMap">
						<div class="grid gap-3 sm:grid-cols-2">
							<UiFormField v-slot="f" label="Release">
								<UiInput :id="f.id" v-model="smRelease" placeholder="my-app@1.2.0" class="font-mono" />
							</UiFormField>
							<UiFormField v-slot="f" label="Minified file URL">
								<UiInput
									:id="f.id"
									v-model="smFileUrl"
									placeholder="https://example.com/assets/main.abc123.js"
									class="font-mono"
								/>
							</UiFormField>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<input
								ref="smInput"
								type="file"
								accept=".map,.json"
								class="sr-only"
								aria-label="Source map file (.map)"
								data-testid="sourcemap-file"
								@change="handleSourceMapFile"
							/>
							<UiButton :icon="Upload" @click="smInput?.click()">Choose .map file</UiButton>
							<span class="min-w-0 truncate text-caption text-fg-subtle">
								{{ smFile ? `${smFile.name} · ${formatSize(smFile.size)}` : 'No file chosen' }}
							</span>
						</div>
						<UiAlert v-if="smError" tone="error">{{ smError }}</UiAlert>
						<div>
							<UiButton
								type="submit"
								variant="primary"
								:loading="uploadingSm"
								:disabled="!smRelease || !smFileUrl || !smContent"
							>
								Upload source map
							</UiButton>
						</div>
					</form>

					<ul v-if="sourceMaps.length > 0" class="mt-4 overflow-hidden rounded-lg border border-border" aria-label="Uploaded source maps">
						<AppFileRow
							v-for="sm in sourceMaps"
							:key="sm.id"
							:tag="sm.release"
							:name="sm.fileUrl"
							:meta="`${formatSize(sm.size)} · ${formatDate(sm.createdAt)}`"
							:delete-label="canDeleteSourceMaps ? `Delete source map ${sm.fileUrl}` : undefined"
							test-id="sourcemap-row"
							@delete="deleteSourceMap(sm)"
						/>
					</ul>
					<p v-else class="mt-4 text-body-s text-fg-subtle">No source maps uploaded yet.</p>
				</UiCard>

				<AppDebugFilesSettings :slug="slug" :can-manage="canManage" />

				<UiCard
					id="symbolication"
					title="Symbolication"
					meta="Crashes symbolicated per hour · 0 = off"
					class="scroll-mt-20"
					padded
				>
					<form class="flex flex-wrap items-end gap-2" @submit.prevent="saveSymbolication">
						<UiFormField v-slot="f" label="Max symbolications per hour" class="w-full sm:w-52">
							<UiInput
								:id="f.id"
								v-model.number="maxSymbolicationsPerHour"
								type="number"
								min="0"
								step="50"
								data-numeric
							/>
						</UiFormField>
						<UiButton type="submit" variant="primary" :loading="savingSymbolication">Save</UiButton>
					</form>
					<div
						v-if="maxSymbolicationsPerHour > 0"
						class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2"
						data-testid="symbolication-usage"
					>
						<span class="text-body-s text-fg-subtle">Current hour</span>
						<span class="text-body-s font-medium text-fg" data-numeric>
							{{ formatNumber(symbolicationsThisHour) }} / {{ formatNumber(maxSymbolicationsPerHour) }}
						</span>
						<UiMeter
							:value="symbolicationsThisHour"
							:max="maxSymbolicationsPerHour"
							label="Symbolications this hour"
						/>
					</div>
					<p class="mt-3 text-caption text-fg-subtle">
						Over the budget, crashes are stored right away with their raw frames, tagged
						<span class="font-mono">symbolication: skipped</span>. The same crash from many devices counts once (cache).
					</p>
				</UiCard>

				<UiCard
					id="inbound-filters"
					title="Inbound filters"
					meta="Drop noisy events before they are stored"
					class="scroll-mt-20"
					padded
				>
					<UiButton :icon="Funnel" :to="`/projects/${slug}/filters`">Manage filters</UiButton>
				</UiCard>

				<UiCard id="danger" title="Danger zone" tone="danger" class="scroll-mt-20" padded>
					<div class="flex flex-wrap items-center gap-4">
						<div class="min-w-0 flex-1">
							<h3 class="text-body-s font-medium text-fg">Delete this project</h3>
							<p class="text-body-s text-fg-muted">
								Once you delete a project, there is no going back. All data will be permanently deleted.
							</p>
						</div>
						<UiButton variant="danger" :icon="Trash2" data-testid="delete-project" @click="deleteProject">
							Delete project
						</UiButton>
					</div>
				</UiCard>
			</div>
		</div>
	</div>
</template>
