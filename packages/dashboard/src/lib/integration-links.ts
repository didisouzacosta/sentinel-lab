// Links that take the user to where each integration credential lives.
// They only open pages: nothing is ever read or copied for the user.
// Kept in one place so a route change in Slack or Kaneo is a one-line fix.

/** Slack app ids look like `A08K2TX4R1Q`. */
const SLACK_APP_ID = /\bA[A-Z0-9]{8,}\b/;

/** The App ID in a pasted app page address (api.slack.com/apps/A…) or the bare id. */
export function parseSlackAppId(raw: string): string | null {
	const match = raw.trim().match(SLACK_APP_ID);
	return match ? match[0] : null;
}

export const slackLinks = {
	/** Slack's "create an app from this manifest" page. */
	createApp(manifest: unknown): string {
		return manifest
			? `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`
			: 'https://api.slack.com/apps?new_app=1';
	},
	/** The list of the user's Slack apps (fallback when the App ID is unknown). */
	apps: 'https://api.slack.com/apps',
	/** "Install to Workspace" for this app. */
	install(appId: string | null | undefined): string {
		return appId
			? `https://api.slack.com/apps/${encodeURIComponent(appId)}/install-on-team`
			: slackLinks.apps;
	},
	/** OAuth & Permissions, where the Bot User OAuth Token is shown. */
	oauth(appId: string | null | undefined): string {
		return appId
			? `https://api.slack.com/apps/${encodeURIComponent(appId)}/oauth`
			: slackLinks.apps;
	},
};

/** `https://kaneo.example.com/api/` → `https://kaneo.example.com`; null when not a URL. */
export function kaneoWebOrigin(baseUrl: string): string | null {
	const value = baseUrl.trim();
	if (!value) return null;
	try {
		const url = new URL(value.includes('://') ? value : `https://${value}`);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return url.origin;
	} catch {
		return null;
	}
}

export const kaneoLinks = {
	/** Account settings → Developer, where Kaneo API keys are created. */
	apiKeys(baseUrl: string): string | null {
		const origin = kaneoWebOrigin(baseUrl);
		return origin ? `${origin}/dashboard/settings/account/developer` : null;
	},
	/** The Kaneo project's integrations page (its one webhook lives there). */
	projectIntegrations(baseUrl: string, projectId: string): string | null {
		const origin = kaneoWebOrigin(baseUrl);
		return origin && projectId
			? `${origin}/dashboard/settings/projects/${encodeURIComponent(projectId)}/integrations`
			: null;
	},
};
