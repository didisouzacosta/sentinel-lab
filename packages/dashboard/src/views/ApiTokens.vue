<script setup lang="ts">
import { KeyRound, Plus } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { api } from '../api/client';
import AppPageHeader from '../components/app/AppPageHeader.vue';
import {
	UiAlert,
	UiButton,
	UiCard,
	UiCopyField,
	UiDialog,
	UiEmptyState,
	UiFormField,
	UiInput,
	UiSegmented,
	UiSkeleton,
	UiTag,
} from '../components/ui';
import { useConfirm } from '../composables/useConfirm';
import { useToast } from '../composables/useToast';
import { timeAgo } from '../lib/format';
import { useAuthStore } from '../stores/auth';

/** Each scope includes the ones before it (worker: lib/token-scopes.ts). */
type Scope = 'read' | 'write' | 'projects';

interface ApiToken {
	id: string;
	userId: string;
	name: string;
	tokenPrefix: string;
	/** Absent on responses from workers that predate scopes: read + write. */
	scopes?: Scope[];
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
}

const toast = useToast();
const askConfirm = useConfirm();
const auth = useAuthStore();

const SCOPE_LABELS: Record<Scope, string> = {
	read: 'Read only',
	write: 'Read & write',
	projects: 'Projects',
};
const SCOPE_HELP: Record<Scope, string> = {
	read: 'Reads projects, DSNs, issues and events. Changes nothing.',
	write: 'Also triages issues, adds notes and edits project settings.',
	projects:
		'Also creates projects, rotates DSN keys and deletes projects — what an agent needs to connect your apps on its own.',
};
// `projects` has the admin area's bar: an admin signed in with a passkey.
const scopeOptions = computed(() =>
	(['read', 'write', 'projects'] as const)
		.filter((s) => s !== 'projects' || auth.canUseAdmin)
		.map((value) => ({ value, label: SCOPE_LABELS[value] })),
);
const accessOf = (t: ApiToken): Scope => t.scopes?.at(-1) ?? 'write';

const tokens = ref<ApiToken[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const createOpen = ref(false);
const newTokenName = ref('');
const newTokenExpiry = ref('');
const newTokenScope = ref<Scope>('write');
const creating = ref(false);
const createError = ref<string | null>(null);

// The raw token is shown once, in its own dialog that only "Done" closes.
const created = ref<{ name: string; raw: string } | null>(null);
const createdOpen = computed({
	get: () => created.value !== null,
	set: (open) => {
		if (!open) created.value = null;
	},
});

const today = new Date().toISOString().split('T')[0];

const isExpired = (t: ApiToken) => !!t.expiresAt && new Date(t.expiresAt) < new Date();
const expiredCount = computed(() => tokens.value.filter(isExpired).length);
const summary = computed(() => {
	const active = tokens.value.length - expiredCount.value;
	return expiredCount.value
		? `${active} active · ${expiredCount.value} expired`
		: `${active} active`;
});

function message(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function formatDate(dateString: string): string {
	return new Date(dateString).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function meta(t: ApiToken): string {
	const used = t.lastUsedAt ? `Last used ${timeAgo(t.lastUsedAt)}` : 'Never used';
	const expires = !t.expiresAt
		? 'Never expires'
		: `${isExpired(t) ? 'Expired' : 'Expires'} ${formatDate(t.expiresAt)}`;
	return `${used} · ${expires} · Created ${formatDate(t.createdAt)}`;
}

async function loadTokens() {
	loading.value = true;
	loadError.value = null;
	try {
		const response = await api.get<{ tokens: ApiToken[] }>('/api/auth/tokens');
		tokens.value = response.tokens;
	} catch (err) {
		loadError.value = message(err, 'Failed to load tokens');
	} finally {
		loading.value = false;
	}
}

function openCreate() {
	newTokenName.value = '';
	newTokenExpiry.value = '';
	newTokenScope.value = 'write';
	createError.value = null;
	createOpen.value = true;
}

async function createToken() {
	const name = newTokenName.value.trim();
	if (!name) return;
	creating.value = true;
	createError.value = null;
	try {
		const body: { name: string; scopes: Scope[]; expiresAt?: string } = {
			name,
			scopes: [newTokenScope.value],
		};
		if (newTokenExpiry.value) body.expiresAt = new Date(newTokenExpiry.value).toISOString();
		const response = await api.post<{ token: ApiToken; rawToken: string }>(
			'/api/auth/tokens',
			body,
		);
		tokens.value.unshift(response.token);
		createOpen.value = false;
		created.value = { name: response.token.name, raw: response.rawToken };
	} catch (err) {
		createError.value = message(err, 'Failed to create token');
	} finally {
		creating.value = false;
	}
}

async function revokeToken(token: ApiToken) {
	const ok = await askConfirm({
		title: `Revoke "${token.name}"?`,
		description: 'Anything using this token stops working right away. This cannot be undone.',
		items: [`${token.tokenPrefix}…`],
		confirmLabel: 'Revoke token',
		tone: 'danger',
	});
	if (!ok) return;
	try {
		await api.delete(`/api/auth/tokens/${token.id}`);
		tokens.value = tokens.value.filter((t) => t.id !== token.id);
		toast.success(`Token "${token.name}" revoked`);
	} catch (err) {
		toast.error(message(err, 'Failed to revoke token'));
	}
}

onMounted(() => loadTokens());
</script>

<template>
	<div class="mx-auto flex max-w-3xl flex-col gap-5">
		<AppPageHeader
			title="API tokens"
			subtitle="Personal tokens for scripts, CI and AI agents. Each token is shown only once."
		>
			<template #actions>
				<UiButton variant="primary" :icon="Plus" data-testid="create-token" @click="openCreate">
					Create token
				</UiButton>
			</template>
		</AppPageHeader>

		<UiSkeleton v-if="loading" :count="3" label="Loading tokens" />

		<UiAlert v-else-if="loadError" tone="error" action-label="Try again" @action="loadTokens">
			{{ loadError }}
		</UiAlert>

		<UiCard v-else-if="tokens.length > 0" title="Your tokens" :meta="summary">
			<ul aria-label="API tokens">
				<li
					v-for="token in tokens"
					:key="token.id"
					class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
					data-testid="token-row"
				>
					<div class="min-w-0 flex-1">
						<div class="flex min-w-0 flex-wrap items-center gap-2">
							<span class="truncate text-body-s font-medium text-fg">{{ token.name }}</span>
							<UiTag>{{ token.tokenPrefix }}…</UiTag>
							<UiTag data-testid="token-access">{{ SCOPE_LABELS[accessOf(token)] }}</UiTag>
						</div>
						<p
							class="mt-1 text-caption"
							:class="isExpired(token) ? 'text-level-error' : 'text-fg-subtle'"
							data-numeric
						>
							{{ meta(token) }}
						</p>
					</div>
					<UiButton
						variant="danger"
						size="sm"
						:aria-label="`Revoke token ${token.name}`"
						@click="revokeToken(token)"
					>
						Revoke
					</UiButton>
				</li>
			</ul>
		</UiCard>

		<UiCard v-else data-testid="tokens-empty">
			<UiEmptyState
				title="No API tokens yet"
				description="Create one for a script, a CI job or an AI agent using the Sentry MCP."
				:icon="KeyRound"
			>
				<UiButton :icon="Plus" @click="openCreate">Create token</UiButton>
			</UiEmptyState>
		</UiCard>

		<UiAlert tone="info">
			Tokens act with your project access and cannot reach the admin API. Revoke a token as soon as
			you stop using it.
		</UiAlert>

		<UiDialog
			v-model:open="createOpen"
			title="Create API token"
			description="The token acts as you on every project you are a member of, up to the access you pick."
			form
			data-testid="token-dialog"
			@submit="createToken"
		>
			<div class="flex flex-col gap-4">
				<UiAlert v-if="createError" tone="error">{{ createError }}</UiAlert>
				<UiFormField v-slot="f" label="Name" help="Helps you recognise it later" required>
					<UiInput
						:id="f.id"
						v-model="newTokenName"
						:aria-describedby="f.describedBy"
						required
						maxlength="100"
						placeholder="e.g. CI pipeline, Claude Code"
						data-testid="token-name"
					/>
				</UiFormField>
				<div class="flex flex-col gap-1.5">
					<span class="text-body-s font-medium text-fg" aria-hidden="true">Access</span>
					<UiSegmented
						v-model="newTokenScope"
						label="Access"
						:options="scopeOptions"
						aria-describedby="token-scope-help"
						class="self-start"
						data-testid="token-scope"
					/>
					<p id="token-scope-help" class="text-caption text-fg-subtle">{{ SCOPE_HELP[newTokenScope] }}</p>
				</div>
				<UiFormField
					v-slot="f"
					label="Expiration (optional)"
					help="Leave empty for a token that never expires"
				>
					<UiInput
						:id="f.id"
						v-model="newTokenExpiry"
						:aria-describedby="f.describedBy"
						type="date"
						:min="today"
						data-testid="token-expiry"
					/>
				</UiFormField>
			</div>
			<template #footer="{ close }">
				<UiButton @click="close">Cancel</UiButton>
				<UiButton
					type="submit"
					variant="primary"
					:loading="creating"
					:disabled="!newTokenName.trim()"
					data-testid="token-submit"
				>
					Create token
				</UiButton>
			</template>
		</UiDialog>

		<UiDialog
			v-model:open="createdOpen"
			title="Copy your new token"
			:description="created ? `${created.name} was created.` : undefined"
			:dismissible="false"
			data-testid="token-created"
		>
			<div v-if="created" class="flex flex-col gap-3.5">
				<UiAlert tone="warning">
					This is the only time the token is shown. Copy it now and store it somewhere safe.
				</UiAlert>
				<UiCopyField :value="created.raw" label="API token" copied-message="Token copied to clipboard" />
				<p class="text-caption text-fg-subtle">
					Use it as <code class="font-mono">SENTRY_AUTH_TOKEN</code> for the Sentry MCP or as a Bearer
					token for the API.
				</p>
			</div>
			<template #footer>
				<UiButton variant="primary" data-testid="token-created-done" @click="createdOpen = false">
					Done
				</UiButton>
			</template>
		</UiDialog>
	</div>
</template>
