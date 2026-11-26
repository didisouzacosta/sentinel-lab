/**
 * Thin client for the Slack Web API, used by the Slack integration. The only
 * credential is the bot token (`xoxb-…`) of a Slack app the user created
 * from the manifest the dashboard shows (SLACK_APP_SCOPES).
 *
 * Outbound hygiene mirrors lib/webhook.ts and lib/kaneo.ts: a fixed https
 * origin, redirects refused, a 10 s timeout, and Slack's response bodies are
 * never logged. Slack answers most failures with `200 {ok:false, error}`;
 * those become a SlackError with a code the caller can act on.
 */

const SLACK_API = 'https://slack.com/api';
const SLACK_TIMEOUT_MS = 10_000;
/** Pages of 200 channels read when listing; more than this is cut off. */
const MAX_CHANNEL_PAGES = 5;

/** Bot scopes the integration needs (the dashboard's app manifest). */
export const SLACK_APP_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'];

export interface SlackCredentials {
	botToken: string;
}

export type SlackErrorCode =
	| 'invalid_token'
	| 'unauthorized'
	| 'missing_scope'
	| 'not_in_channel'
	| 'channel_not_found'
	| 'channel_archived'
	| 'message_not_found'
	| 'ratelimited'
	| 'unreachable'
	| 'bad_request'
	| 'server_error'
	| 'bad_response';

export class SlackError extends Error {
	constructor(
		readonly code: SlackErrorCode,
		message: string,
		/** For `ratelimited`: seconds Slack asked to wait. */
		readonly retryAfter?: number,
	) {
		super(message);
	}
}

export interface SlackIdentity {
	teamId: string;
	teamName: string;
	botUserId: string;
	/** Workspace URL, e.g. `https://acme.slack.com/`. */
	url: string;
}

export interface SlackChannel {
	id: string;
	name: string;
	isPrivate: boolean;
	isMember: boolean;
}

export interface SlackMessage {
	text: string;
	blocks?: unknown[];
}

/** A bot token, or the reason it is not one. */
export function checkBotToken(
	raw: string,
): { ok: true; token: string } | { ok: false; reason: string } {
	const token = raw.trim();
	if (!token.startsWith('xoxb-')) {
		return {
			ok: false,
			reason: 'Use the Bot User OAuth Token of the Slack app (it starts with xoxb-)',
		};
	}
	if (token.length > 256 || /\s/.test(token)) {
		return { ok: false, reason: 'That does not look like a Slack bot token' };
	}
	return { ok: true, token };
}

const UNAUTHORIZED = new Set([
	'invalid_auth',
	'not_authed',
	'token_revoked',
	'token_expired',
	'account_inactive',
	'no_permission',
	'ekm_access_denied',
]);

function slackFailure(error: string, needed: unknown): SlackError {
	if (UNAUTHORIZED.has(error)) {
		return new SlackError(
			'unauthorized',
			`Slack refused the token (${error}): copy the Bot User OAuth Token again`,
		);
	}
	switch (error) {
		case 'missing_scope':
			return new SlackError(
				'missing_scope',
				`The Slack app is missing the ${typeof needed === 'string' ? needed : 'required'} scope: add it and reinstall the app`,
			);
		case 'not_in_channel':
			return new SlackError(
				'not_in_channel',
				'The bot is not in that channel: invite it with /invite @<bot name>',
			);
		case 'channel_not_found':
			return new SlackError(
				'channel_not_found',
				'Slack channel not found (private channels need the bot invited first)',
			);
		case 'message_not_found':
			return new SlackError('message_not_found', 'The Slack message was deleted');
		case 'is_archived':
			return new SlackError('channel_archived', 'That Slack channel is archived');
		case 'ratelimited':
			return new SlackError('ratelimited', 'Slack is rate limiting this app', 30);
		case 'internal_error':
		case 'fatal_error':
		case 'service_unavailable':
		case 'request_timeout':
			return new SlackError('server_error', `Slack failed (${error})`);
		default:
			return new SlackError('bad_request', `Slack answered ${error.slice(0, 80)}`);
	}
}

export function createSlackClient(credentials: SlackCredentials, fetcher?: typeof fetch) {
	const send = fetcher ?? fetch;
	const checked = checkBotToken(credentials.botToken);
	if (!checked.ok) throw new SlackError('invalid_token', checked.reason);
	const token = checked.token;

	async function call<T>(
		method: string,
		options: { query?: Record<string, string>; body?: Record<string, unknown> } = {},
	): Promise<T> {
		const url = new URL(`${SLACK_API}/${method}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (options.body) headers['Content-Type'] = 'application/json; charset=utf-8';

		let response: Response;
		try {
			response = await send(url.toString(), {
				method: options.body ? 'POST' : 'GET',
				headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
				// Workers reject redirect: 'error'; 'manual' plus the 3xx check below
				// refuses redirects the same way.
				redirect: 'manual',
				signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
			});
		} catch (error) {
			const timedOut = error instanceof Error && error.name === 'TimeoutError';
			throw new SlackError(
				'unreachable',
				timedOut ? 'Slack did not answer within 10 seconds' : 'Slack could not be reached',
			);
		}

		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new SlackError('bad_response', `Slack answered with a redirect (${response.status})`);
		}
		if (response.status === 429) {
			await response.body?.cancel();
			const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
			throw new SlackError(
				'ratelimited',
				'Slack is rate limiting this app',
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30,
			);
		}
		if (response.status >= 500) {
			await response.body?.cancel();
			throw new SlackError('server_error', `Slack answered ${response.status}`);
		}
		const data = (await response.json().catch(() => null)) as
			| ({ ok?: boolean; error?: unknown; needed?: unknown } & Record<string, unknown>)
			| null;
		if (!data || typeof data.ok !== 'boolean') {
			throw new SlackError('bad_response', 'Slack answered with something unexpected');
		}
		if (!data.ok) {
			throw slackFailure(
				typeof data.error === 'string' ? data.error : 'unknown_error',
				data.needed,
			);
		}
		return data as T;
	}

	function toChannel(raw: Record<string, unknown>): SlackChannel {
		return {
			id: String(raw.id),
			name: String(raw.name ?? raw.id),
			isPrivate: raw.is_private === true,
			isMember: raw.is_member === true,
		};
	}

	return {
		async authTest(): Promise<SlackIdentity> {
			const data = await call<{ team_id?: string; team?: string; user_id?: string; url?: string }>(
				'auth.test',
				{ body: {} },
			);
			return {
				teamId: data.team_id ?? '',
				teamName: data.team ?? '',
				botUserId: data.user_id ?? '',
				url: data.url ?? '',
			};
		},

		/** Public channels, and private ones the bot was invited to; no archived ones. */
		async listChannels(): Promise<{ channels: SlackChannel[]; truncated: boolean }> {
			const channels: SlackChannel[] = [];
			let cursor = '';
			for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
				const data = await call<{
					channels?: Record<string, unknown>[];
					response_metadata?: { next_cursor?: string };
				}>('conversations.list', {
					query: {
						types: 'public_channel,private_channel',
						exclude_archived: 'true',
						limit: '200',
						...(cursor ? { cursor } : {}),
					},
				});
				for (const raw of data.channels ?? []) channels.push(toChannel(raw));
				cursor = data.response_metadata?.next_cursor ?? '';
				if (!cursor) break;
			}
			channels.sort((a, b) => a.name.localeCompare(b.name));
			return { channels, truncated: cursor !== '' };
		},

		async getChannel(channelId: string): Promise<SlackChannel & { isArchived: boolean }> {
			const data = await call<{ channel: Record<string, unknown> }>('conversations.info', {
				query: { channel: channelId },
			});
			return { ...toChannel(data.channel), isArchived: data.channel.is_archived === true };
		},

		async postMessage(
			channelId: string,
			message: SlackMessage,
			threadTs?: string,
		): Promise<{ channel: string; ts: string }> {
			const data = await call<{ channel: string; ts: string }>('chat.postMessage', {
				body: {
					channel: channelId,
					text: message.text,
					blocks: message.blocks,
					unfurl_links: false,
					unfurl_media: false,
					...(threadTs ? { thread_ts: threadTs } : {}),
				},
			});
			return { channel: data.channel, ts: data.ts };
		},

		async updateMessage(channelId: string, ts: string, message: SlackMessage): Promise<void> {
			await call('chat.update', {
				body: { channel: channelId, ts, text: message.text, blocks: message.blocks },
			});
		},

		async getPermalink(channelId: string, ts: string): Promise<string> {
			const data = await call<{ permalink: string }>('chat.getPermalink', {
				query: { channel: channelId, message_ts: ts },
			});
			return data.permalink;
		},
	};
}

export type SlackClient = ReturnType<typeof createSlackClient>;

/** `issue_links.external_id` of a Slack message: `<channel>:<ts>`. */
export function slackMessageId(channel: string, ts: string): string {
	return `${channel}:${ts}`;
}

export function parseSlackMessageId(externalId: string): { channel: string; ts: string } | null {
	const at = externalId.indexOf(':');
	if (at <= 0 || at === externalId.length - 1) return null;
	return { channel: externalId.slice(0, at), ts: externalId.slice(at + 1) };
}

/** The app manifest the dashboard offers for "Create an app from a manifest". */
export function slackAppManifest(name = 'Sentinel') {
	return {
		display_information: {
			name,
			description: 'Error alerts from Sentinel',
			background_color: '#1a1d21',
		},
		features: { bot_user: { display_name: name, always_online: false } },
		oauth_config: { scopes: { bot: SLACK_APP_SCOPES } },
		settings: {
			org_deploy_enabled: false,
			socket_mode_enabled: false,
			token_rotation_enabled: false,
		},
	};
}
