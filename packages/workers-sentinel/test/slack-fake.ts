/**
 * A fake Slack Web API behind globalThis.fetch (same trick as kaneo-fake.ts:
 * the tests, the worker and its Durable Objects share one isolate). Only
 * https://slack.com/api/* is intercepted.
 */
import { vi } from 'vitest';

export const SLACK_TOKEN = 'xoxb-1111-2222-fake-slack-token';

export interface FakeSlackRequest {
	method: string;
	api: string;
	query: URLSearchParams;
	headers: Headers;
	body: Record<string, unknown> | undefined;
}

export interface FakeSlackMessage {
	channel: string;
	ts: string;
	text: string;
	blocks: unknown[];
	threadTs?: string;
	edits: { text: string; blocks: unknown[] }[];
}

export const FAKE_CHANNELS = [
	{ id: 'C0ERRORS', name: 'errors', is_private: false, is_member: false, is_archived: false },
	{ id: 'C0GENERAL', name: 'general', is_private: false, is_member: true, is_archived: false },
	{ id: 'G0SECRET', name: 'secret', is_private: true, is_member: true, is_archived: false },
	{ id: 'G0LOCKED', name: 'locked', is_private: true, is_member: false, is_archived: false },
	{ id: 'C0OLD', name: 'old', is_private: false, is_member: false, is_archived: true },
];

export const fakeSlack = {
	requests: [] as FakeSlackRequest[],
	messages: [] as FakeSlackMessage[],
	validToken: SLACK_TOKEN,
	/** Make chat.* answer `{ok:false, error}` with this code. */
	failPosts: null as string | null,
	/** Answer the next chat.* call with HTTP 429. */
	rateLimitOnce: false,
	nextTs: 1,

	reset() {
		this.requests = [];
		this.messages = [];
		this.validToken = SLACK_TOKEN;
		this.failPosts = null;
		this.rateLimitOnce = false;
		this.nextTs = 1;
	},

	calls(api: string) {
		return this.requests.filter((r) => r.api === api);
	},

	/** Top-level messages (not thread replies). */
	posts() {
		return this.messages.filter((m) => !m.threadTs);
	},

	replies(ts: string) {
		return this.messages.filter((m) => m.threadTs === ts);
	},
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

async function handle(url: URL, init: RequestInit = {}): Promise<Response> {
	const method = (init.method ?? 'GET').toUpperCase();
	const headers = new Headers(init.headers);
	const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
	const api = url.pathname.replace(/^\/api\//, '');
	fakeSlack.requests.push({ method, api, query: url.searchParams, headers, body });

	if (headers.get('Authorization') !== `Bearer ${fakeSlack.validToken}`) {
		return json({ ok: false, error: 'invalid_auth' });
	}
	const param = (name: string) =>
		(body?.[name] as string | undefined) ?? url.searchParams.get(name) ?? undefined;
	const channelOf = (id: string | undefined) => FAKE_CHANNELS.find((c) => c.id === id);

	if (api.startsWith('chat.')) {
		if (fakeSlack.rateLimitOnce) {
			fakeSlack.rateLimitOnce = false;
			return json({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '7' });
		}
		if (fakeSlack.failPosts && api !== 'chat.getPermalink') {
			return json({ ok: false, error: fakeSlack.failPosts });
		}
	}

	switch (api) {
		case 'auth.test':
			return json({
				ok: true,
				url: 'https://acme.slack.com/',
				team: 'Acme',
				team_id: 'T0ACME',
				user: 'sentinel',
				user_id: 'U0BOT',
				bot_id: 'B0BOT',
			});
		case 'conversations.list': {
			const visible = FAKE_CHANNELS.filter((c) => !c.is_archived && (!c.is_private || c.is_member));
			// Two pages, to exercise the cursor
			const cursor = url.searchParams.get('cursor');
			const page = cursor === 'page2' ? visible.slice(2) : visible.slice(0, 2);
			return json({
				ok: true,
				channels: page,
				response_metadata: { next_cursor: cursor === 'page2' ? '' : 'page2' },
			});
		}
		case 'conversations.info': {
			const channel = channelOf(param('channel'));
			if (!channel || (channel.is_private && !channel.is_member)) {
				return json({ ok: false, error: 'channel_not_found' });
			}
			return json({ ok: true, channel });
		}
		case 'chat.postMessage': {
			const channel = channelOf(param('channel'));
			if (!channel) return json({ ok: false, error: 'channel_not_found' });
			if (channel.is_private && !channel.is_member) {
				return json({ ok: false, error: 'not_in_channel' });
			}
			const message: FakeSlackMessage = {
				channel: channel.id,
				ts: `1700000000.${String(fakeSlack.nextTs++).padStart(6, '0')}`,
				text: String(body?.text ?? ''),
				blocks: (body?.blocks as unknown[]) ?? [],
				threadTs: body?.thread_ts as string | undefined,
				edits: [],
			};
			fakeSlack.messages.push(message);
			return json({ ok: true, channel: message.channel, ts: message.ts });
		}
		case 'chat.update': {
			const message = fakeSlack.messages.find(
				(m) => m.channel === param('channel') && m.ts === param('ts'),
			);
			if (!message) return json({ ok: false, error: 'message_not_found' });
			message.edits.push({
				text: String(body?.text ?? ''),
				blocks: (body?.blocks as unknown[]) ?? [],
			});
			return json({ ok: true, channel: message.channel, ts: message.ts });
		}
		case 'chat.getPermalink':
			return json({
				ok: true,
				permalink: `https://acme.slack.com/archives/${param('channel')}/p${String(param('message_ts')).replace('.', '')}`,
			});
		default:
			return json({ ok: false, error: 'unknown_method' });
	}
}

/**
 * Install the fake (call in beforeEach; vi.restoreAllMocks in afterEach).
 * Installed after installFakeKaneo, both fakes answer.
 */
export function installFakeSlack(): void {
	fakeSlack.reset();
	const current = globalThis.fetch;
	const previous: typeof fetch = vi.isMockFunction(current)
		? ((current.getMockImplementation() as typeof fetch | undefined) ?? current)
		: current;
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin === 'https://slack.com') return handle(url, init);
		return previous(input, init);
	});
}
