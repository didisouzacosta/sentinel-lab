<script setup lang="ts">
// Dev-only gallery of the design system (route /__ui, registered only when
// import.meta.env.DEV). Mirrors the Figma page "Componentes" for review.
import { Check, Clock, EyeOff, Moon, Plus, Search, Sun, Trash2 } from 'lucide-vue-next';
import { ref } from 'vue';
import {
	UiAlert,
	UiAvatar,
	UiBadge,
	UiButton,
	UiCard,
	UiCheckbox,
	UiCode,
	UiCopyField,
	UiDescriptionList,
	UiDialog,
	UiEmptyState,
	UiFormField,
	UiInput,
	UiMenu,
	UiSegmented,
	UiSelect,
	UiSkeleton,
	UiTabs,
	UiTag,
} from '../../components/ui';
import { useConfirm } from '../../composables/useConfirm';
import { useTheme } from '../../composables/useTheme';
import { useToast } from '../../composables/useToast';

const { theme, toggle } = useTheme();
const toast = useToast();
const askConfirm = useConfirm();

const tab = ref('unresolved');
const frames = ref('in-app');
const dialogOpen = ref(false);
const email = ref('maria@example.com');
const env = ref('production');
const checked = ref(true);

async function askDelete() {
	const ok = await askConfirm({
		title: 'Delete 2 issues?',
		description: 'All events and attachments are removed. This cannot be undone.',
		confirmLabel: 'Delete 2 issues',
		tone: 'danger',
		items: [
			'RangeError: Maximum call stack size exceeded',
			'NetworkError: Failed to fetch /api/cart',
		],
	});
	if (ok) toast.success('2 issues deleted');
	else toast.info('Nothing was deleted');
}
</script>

<template>
	<main class="min-h-screen bg-canvas px-8 py-8 text-fg">
		<header class="mb-8 flex items-center gap-3">
			<div class="flex-1">
				<h1 class="text-heading-l">Sentinel design system</h1>
				<p class="text-body-s text-fg-muted">Dev-only gallery · same names and variants as the Figma components</p>
			</div>
			<UiButton :icon="theme === 'dark' ? Sun : Moon" @click="toggle">
				{{ theme === 'dark' ? 'Light theme' : 'Dark theme' }}
			</UiButton>
		</header>

		<div class="grid gap-6 lg:grid-cols-2">
			<UiCard title="Button" padded>
				<div class="flex flex-wrap items-center gap-2">
					<UiButton variant="primary" :icon="Plus">Create user</UiButton>
					<UiButton>Secondary</UiButton>
					<UiButton variant="ghost">Ghost</UiButton>
					<UiButton variant="danger" :icon="Trash2">Delete</UiButton>
					<UiButton variant="primary" loading>Saving</UiButton>
					<UiButton size="sm" :icon="Check">Resolve</UiButton>
					<UiButton size="sm" :icon="EyeOff">Ignore</UiButton>
				</div>
			</UiCard>

			<UiCard title="Badge · Tag · Avatar" padded>
				<div class="flex flex-wrap items-center gap-2">
					<UiBadge v-for="l in ['fatal', 'error', 'warning', 'info', 'debug']" :key="l" :level="l" />
					<UiBadge v-for="s in ['unresolved', 'resolved', 'ignored', 'snoozed']" :key="s" :status="s" />
					<UiTag>javascript</UiTag>
					<UiTag tone="accent" removable remove-label="Remove browser filter">browser: Chrome</UiTag>
					<UiAvatar name="Adriano" />
				</div>
			</UiCard>

			<UiCard title="Fields" padded>
				<div class="grid gap-4 sm:grid-cols-2">
					<UiFormField v-slot="f" label="Email" help="Used to sign in">
						<UiInput :id="f.id" v-model="email" :aria-describedby="f.describedBy" />
					</UiFormField>
					<UiFormField v-slot="f" label="Email" error="This email is already in use">
						<UiInput :id="f.id" v-model="email" :invalid="f.invalid" :aria-describedby="f.describedBy" />
					</UiFormField>
					<UiFormField v-slot="f" label="Environment">
						<UiSelect :id="f.id" v-model="env">
							<option value="production">production</option>
							<option value="staging">staging</option>
						</UiSelect>
					</UiFormField>
					<UiFormField v-slot="f" label="Search">
						<UiInput :id="f.id" :icon="Search" placeholder="Filter by name or email" />
					</UiFormField>
					<UiCheckbox v-model="checked" label="Make administrator" />
				</div>
			</UiCard>

			<UiCard title="Tabs · Segmented">
				<div class="flex flex-col gap-4 px-4 pb-4">
					<UiTabs
						v-model="tab"
						label="Issue status"
						:items="[
							{ value: 'unresolved', label: 'Unresolved', count: 128 },
							{ value: 'resolved', label: 'Resolved', count: 342 },
							{ value: 'ignored', label: 'Ignored', count: 17 },
						]"
					/>
					<UiSegmented
						v-model="frames"
						label="Frames"
						:options="[
							{ value: 'in-app', label: 'In-app' },
							{ value: 'all', label: 'All frames' },
						]"
					/>
				</div>
			</UiCard>

			<UiCard title="CopyField · Code" padded>
				<div class="flex flex-col gap-4">
					<UiCopyField label="DSN" value="https://4f9a1c@sentinel.example.com/7e2b0d51-9c4a" />
					<UiCode language="Terminal" code="npm install @sentry/cloudflare --save" />
				</div>
			</UiCard>

			<UiCard title="Event" meta="DescriptionList">
				<UiDescriptionList
					:items="[
						{ label: 'Event ID', value: '8f3c2a91e04b4d6f', mono: true },
						{ label: 'Environment', value: 'production' },
						{ label: 'Release', value: 'web@2.14.0', mono: true },
					]"
				/>
			</UiCard>

			<UiCard title="Alert" padded>
				<div class="flex flex-col gap-2">
					<UiAlert tone="error" action-label="Try again">Could not load issues (503).</UiAlert>
					<UiAlert tone="warning">Rate limit at 80% of the hourly quota.</UiAlert>
					<UiAlert tone="info">Waiting for the first event…</UiAlert>
					<UiAlert tone="success">Receiving events · last one 3 min ago</UiAlert>
				</div>
			</UiCard>

			<UiCard title="Overlays · feedback" padded>
				<div class="flex flex-wrap items-center gap-2">
					<UiButton variant="primary" @click="dialogOpen = true">Open dialog</UiButton>
					<UiButton variant="danger" @click="askDelete">Confirm (danger)</UiButton>
					<UiMenu
						label="Snooze"
						title="Snooze for"
						:items="[
							{ value: 30, label: '30 minutes', icon: Clock },
							{ value: 120, label: '2 hours', icon: Clock },
							{ value: 1440, label: '24 hours', icon: Clock },
						]"
						@select="(v) => toast.success(`Snoozed for ${v} minutes`, { action: { label: 'Undo', onClick: () => {} } })"
					>
						<template #trigger="{ props }">
							<UiButton v-bind="props" :icon="Clock">Snooze</UiButton>
						</template>
					</UiMenu>
					<UiButton @click="toast.error('Merge failed: issues belong to different projects')">Error toast</UiButton>
				</div>
			</UiCard>

			<UiCard title="Loading" class="lg:col-span-2">
				<UiSkeleton :count="3" label="Loading issues" />
			</UiCard>

			<UiCard class="lg:col-span-2">
				<UiEmptyState title="No issues yet" description="Configure an SDK to start capturing errors.">
					<UiButton variant="primary">Set up an SDK</UiButton>
				</UiEmptyState>
			</UiCard>
		</div>

		<UiDialog
			v-model:open="dialogOpen"
			title="Create user"
			description="They sign in with a temporary password and must change it first."
			form
			@submit="
				dialogOpen = false;
				toast.success('User created');
			"
		>
			<div class="flex flex-col gap-3.5">
				<UiFormField v-slot="f" label="Name">
					<UiInput :id="f.id" autofocus placeholder="Maria Silva" />
				</UiFormField>
				<UiFormField v-slot="f" label="Email" error="This email is already in use">
					<UiInput :id="f.id" v-model="email" :invalid="f.invalid" :aria-describedby="f.describedBy" />
				</UiFormField>
			</div>
			<template #footer="{ close }">
				<UiButton variant="ghost" @click="close">Cancel</UiButton>
				<UiButton variant="primary" type="submit">Create user</UiButton>
			</template>
		</UiDialog>
	</main>
</template>
