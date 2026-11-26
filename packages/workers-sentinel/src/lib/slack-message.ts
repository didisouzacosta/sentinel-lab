/**
 * The Slack messages Sentinel posts for an issue (Block Kit plus the `text`
 * fallback Slack shows in notifications). Pure (no I/O) so it is easy to test.
 *
 * No personal data: the event's user and request headers are left out, as in
 * the Kaneo task (lib/kaneo-task.ts). No interactive buttons either — links
 * are mrkdwn, so the Slack app needs no Interactivity request URL.
 */

import { summarizeEvent } from './event-summary';
import type { SlackMessage } from './slack';

const MAX_TITLE = 150;
const MAX_FIELD = 200;
const MAX_EXCEPTION = 500;
const MAX_FRAMES = 5;
/** Slack's limit for a section's text. */
const MAX_SECTION = 3000;

export interface SlackIssue {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	status: string;
	count: number;
	userCount: number;
	firstSeen: string;
	lastSeen: string;
}

export interface SlackMessageContext {
	/** Dashboard URL of the issue. */
	permalink: string;
	/** Sentinel project name (or slug) shown in the message. */
	projectName: string;
}

const LEVEL_EMOJI: Record<string, string> = {
	fatal: ':skull:',
	error: ':rotating_light:',
	warning: ':warning:',
	info: ':information_source:',
	debug: ':mag:',
};

function oneLine(value: unknown, max: number): string {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escape the three characters Slack mrkdwn treats as control. */
function esc(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape, then cut to `max` characters without leaving half an entity
 * (`&am…`). Escaping can grow text up to five times, so length limits must be
 * applied after it: Slack refuses a section over 3000 characters.
 */
function escFit(value: string, max: number): string {
	const escaped = esc(value);
	if (escaped.length <= max) return escaped;
	return `${escaped.slice(0, max - 1).replace(/&[a-z]*$/, '')}…`;
}

/** Inline code that survives backticks inside the value. */
function code(value: string): string {
	return `\`${esc(value.replace(/`/g, "'"))}\``;
}

/** `<!date^…>` renders in each reader's own time zone. */
function when(iso: string): string {
	const seconds = Math.floor(Date.parse(iso) / 1000);
	if (!Number.isFinite(seconds)) return esc(iso);
	return `<!date^${seconds}^{date_short_pretty} {time}|${esc(iso)}>`;
}

function emoji(level: string): string {
	return LEVEL_EMOJI[level] ?? LEVEL_EMOJI.error;
}

function link(url: string, label: string): string {
	return `<${url.replace(/[<>|]/g, encodeURIComponent)}|${esc(label)}>`;
}

/**
 * The issue's message. `state` changes the header: a new issue, one that came
 * back after being resolved, or one resolved in Sentinel (the update Sentinel
 * makes to the original message).
 */
export function buildSlackIssueMessage(
	issue: SlackIssue,
	latestEvent: Record<string, unknown> | null,
	context: SlackMessageContext,
	state: 'new' | 'regressed' | 'resolved' = 'new',
): SlackMessage {
	const summary = latestEvent ? summarizeEvent(latestEvent) : null;
	const title = oneLine(issue.title, MAX_TITLE) || 'Untitled issue';
	const project = oneLine(context.projectName, 80);
	const prefix =
		state === 'resolved'
			? ':white_check_mark: Resolved'
			: state === 'regressed'
				? `${emoji(issue.level)} Came back`
				: `${emoji(issue.level)} New ${issue.level}`;

	const fields: string[] = [
		`*Project*\n${esc(project)}`,
		`*Level*\n${esc(issue.level)}`,
		`*Environment*\n${summary?.environment ? esc(oneLine(summary.environment, MAX_FIELD)) : '—'}`,
		`*Release*\n${summary?.release ? code(oneLine(summary.release, MAX_FIELD)) : '—'}`,
		`*Events*\n${issue.count}`,
		`*Users*\n${issue.userCount}`,
	];

	const titleLine =
		state === 'resolved' ? `~${esc(title)}~` : `*${link(context.permalink, title)}*`;
	const blocks: unknown[] = [
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `${prefix} · ${esc(project)}\n${titleLine}${issue.culprit ? `\n${code(oneLine(issue.culprit, MAX_FIELD))}` : ''}`,
			},
		},
		{ type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
	];

	if (state !== 'resolved') {
		const exception = summary?.exceptions.at(-1);
		if (exception) {
			const head = [exception.type, exception.value].filter(Boolean).join(': ');
			const frames = exception.frames.slice(0, MAX_FRAMES).map((frame) => oneLine(frame, 200));
			const body = [oneLine(head || 'Error', MAX_EXCEPTION), ...frames]
				.join('\n')
				.replace(/```/g, "'''");
			blocks.push({
				type: 'section',
				text: { type: 'mrkdwn', text: `\`\`\`${escFit(body, MAX_SECTION - 6)}\`\`\`` },
			});
		} else if (summary?.message) {
			blocks.push({
				type: 'section',
				text: { type: 'mrkdwn', text: code(oneLine(summary.message, MAX_EXCEPTION)) },
			});
		}
	}

	blocks.push({
		type: 'context',
		elements: [
			{
				type: 'mrkdwn',
				text: `${link(context.permalink, 'Open in Sentinel')} · first seen ${when(issue.firstSeen)} · last seen ${when(issue.lastSeen)}`,
			},
		],
	});

	return {
		// Escaped too: an error title is attacker-controlled (DSNs are public),
		// and `<!channel>` in the notification text must not reach Slack as a
		// mention.
		text: esc(`${prefix.replace(/^:[a-z_]+: /, '')} in ${project}: ${title}`),
		blocks,
	};
}

/** Thread reply when a resolved issue receives events again. */
export function buildSlackRegressionReply(
	issue: SlackIssue,
	context: SlackMessageContext,
): SlackMessage {
	const text = `${emoji(issue.level)} This error came back after being resolved — ${issue.count} events so far, last seen ${when(issue.lastSeen)}. ${link(context.permalink, 'Open in Sentinel')}`;
	return {
		text: `This error came back after being resolved (${issue.count} events so far)`,
		blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
	};
}

/** The message "Test" posts from the settings page. */
export function buildSlackTestMessage(projectName: string, settingsUrl: string): SlackMessage {
	const project = esc(oneLine(projectName, 80));
	return {
		text: `Sentinel is connected to this channel for ${project}`,
		blocks: [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: `:white_check_mark: Sentinel is connected to this channel for *${project}*.\nNew errors, errors that come back and resolutions will show up here. ${link(settingsUrl, 'Settings')}`,
				},
			},
		],
	};
}
