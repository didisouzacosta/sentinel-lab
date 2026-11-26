// Integration shapes as the API returns them (secrets masked) and the rules
// that turn them into a connection state, shared by the Integrations
// overview and each integration page so both always agree.
import type { ConnectionState } from '../components/ui/UiStatus.vue';

/** pending: credentials verified and saved, destination not chosen yet. */
export type IntegrationStatus = 'pending' | 'connected';

export interface SlackIntegration {
	id: string;
	enabled: boolean;
	status: IntegrationStatus;
	appId: string | null;
	teamId: string;
	teamName: string;
	botUserId: string;
	channelId: string;
	channelName: string;
	channelPrivate: boolean;
	minLevel: string;
	environments: string[];
	notifyRegression: boolean;
	notifyResolved: boolean;
	botToken: string | null;
	credentialsReadable: boolean;
	lastError: string | null;
	lastErrorAt: string | null;
}

export interface KaneoIntegration {
	id: string;
	enabled: boolean;
	status: IntegrationStatus;
	baseUrl: string;
	workspaceId: string;
	workspaceName: string | null;
	kaneoProjectId: string;
	kaneoProjectName: string;
	kaneoProjectSlug: string;
	createColumn: string;
	doneColumn: string;
	reopenColumn: string;
	autoCreate: boolean;
	minLevel: string;
	environments: string[];
	apiKey: string | null;
	credentialsReadable: boolean;
	lastError: string | null;
	lastErrorAt: string | null;
	/** Kaneo → Sentinel webhook: installed, in_use (another webhook) or failed. */
	webhookStatus: 'installed' | 'in_use' | 'failed' | null;
	webhookError: string | null;
}

export interface ConnectionSummary {
	state: ConnectionState;
	/** Header title on the integration page. */
	title: string;
	/** One line under the title, and the overview card summary. */
	summary: string;
}

export const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];

export function levelPhrase(level: string): string {
	return level === 'fatal' ? 'fatal only' : `${level} and above`;
}

export function environmentsPhrase(environments: string[]): string {
	return environments.length ? environments.join(', ') : 'all environments';
}

export function splitEnvironments(value: string): string[] {
	return value
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);
}

export function slackSummary(integration: SlackIntegration | null): ConnectionSummary {
	if (!integration) {
		return {
			state: 'off',
			title: 'Not connected',
			summary: 'Not set up yet',
		};
	}
	if (!integration.credentialsReadable) {
		return {
			state: 'attention',
			title: 'Needs attention',
			summary: 'The saved bot token can no longer be read. Paste it again.',
		};
	}
	if (integration.status === 'pending') {
		return {
			state: 'pending',
			title: 'Setup incomplete',
			summary: 'The bot token is saved. Pick a channel to start receiving alerts.',
		};
	}
	const channel = `#${integration.channelName}`;
	if (integration.lastError) {
		return {
			state: 'attention',
			title: `Connected to ${channel}`,
			summary: `Last delivery failed: ${integration.lastError}`,
		};
	}
	return {
		state: 'connected',
		title: `Connected to ${channel}`,
		summary: `${channel} · ${levelPhrase(integration.minLevel)}`,
	};
}

export function kaneoSummary(integration: KaneoIntegration | null): ConnectionSummary {
	if (!integration) {
		return { state: 'off', title: 'Not connected', summary: 'Not set up yet' };
	}
	if (!integration.credentialsReadable) {
		return {
			state: 'attention',
			title: 'Needs attention',
			summary: 'The saved API key can no longer be read. Enter it again.',
		};
	}
	if (integration.status === 'pending') {
		return {
			state: 'pending',
			title: 'Setup incomplete',
			summary: 'The API key is saved. Choose the Kaneo project to start creating tasks.',
		};
	}
	const project = `${integration.kaneoProjectName} (${integration.kaneoProjectSlug})`;
	if (integration.lastError) {
		return {
			state: 'attention',
			title: `Connected to ${project}`,
			summary: `Last delivery failed: ${integration.lastError}`,
		};
	}
	if (integration.webhookStatus !== 'installed') {
		return {
			state: 'attention',
			title: `Connected to ${project} · one-way`,
			summary: `${project} · two-way sync off`,
		};
	}
	return {
		state: 'connected',
		title: `Connected to ${project}`,
		summary: `${project} · two-way sync`,
	};
}

export function webhookSummary(url: string | null | undefined): ConnectionSummary {
	if (!url) return { state: 'off', title: 'Not set up', summary: 'Not set up yet' };
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		/* show the raw value */
	}
	return {
		state: 'connected',
		title: 'Configured',
		summary: `${host} · new issues and regressions`,
	};
}
