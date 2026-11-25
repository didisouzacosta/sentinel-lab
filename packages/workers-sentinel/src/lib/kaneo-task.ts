/**
 * The Kaneo task Sentinel creates for an issue: title, markdown description
 * and priority. Pure (no I/O) so it is easy to test and reuse.
 *
 * No personal data: the event's user (email, IP, id) and request headers are
 * left out; only what describes the error itself goes into the task.
 */

import { summarizeEvent } from './event-summary';
import type { KaneoPriority } from './kaneo';

const MAX_TITLE = 200;
const MAX_FRAMES = 15;
const MAX_MESSAGE = 1000;

export interface TaskIssue {
	id: string;
	title: string;
	culprit: string | null;
	level: string;
	count: number;
	userCount: number;
	firstSeen: string;
	lastSeen: string;
}

export interface TaskContext {
	/** Dashboard URL of the issue. */
	permalink: string;
	/** Sentinel project slug (for the agent hint). */
	projectSlug: string;
}

/** fatal→urgent, error→high, warning→medium, anything else→low. */
export function priorityForLevel(level: string): KaneoPriority {
	switch (level) {
		case 'fatal':
			return 'urgent';
		case 'error':
			return 'high';
		case 'warning':
			return 'medium';
		default:
			return 'low';
	}
}

function oneLine(value: unknown, max: number): string {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Inline code that survives backticks inside the value. */
function code(value: string): string {
	return `\`${value.replace(/`/g, "'")}\``;
}

export function buildKaneoTask(
	issue: TaskIssue,
	latestEvent: Record<string, unknown> | null,
	context: TaskContext,
): { title: string; description: string; priority: KaneoPriority } {
	const summary = latestEvent ? summarizeEvent(latestEvent) : null;
	const title = oneLine(`[${issue.level}] ${issue.title}`, MAX_TITLE);

	const rows: [string, string][] = [
		['Level', issue.level],
		['Where', issue.culprit ? code(oneLine(issue.culprit, 300)) : '—'],
		['Environment', summary?.environment ? oneLine(summary.environment, 100) : '—'],
		['Release', summary?.release ? code(oneLine(summary.release, 200)) : '—'],
		['Events', String(issue.count)],
		['Users', String(issue.userCount)],
		['First seen', issue.firstSeen],
		['Last seen', issue.lastSeen],
	];

	const lines: string[] = [
		`**Sentinel** · [Open the issue](${context.permalink})`,
		'',
		'| | |',
		'|---|---|',
		...rows.map(([label, value]) => `| ${label} | ${value.replace(/\|/g, '\\|')} |`),
	];

	const exceptions = summary?.exceptions ?? [];
	if (exceptions.length > 0) {
		lines.push('', '### Exception');
		for (const exception of exceptions.slice(-3).reverse()) {
			const head = [exception.type, exception.value].filter(Boolean).join(': ');
			lines.push('', code(oneLine(head || 'Error', MAX_MESSAGE)));
			const frames = exception.frames.slice(0, MAX_FRAMES);
			if (frames.length > 0) {
				lines.push('', '```', ...frames.map((frame) => oneLine(frame, 300)), '```');
			}
		}
	} else if (summary?.message) {
		lines.push('', '### Message', '', code(oneLine(summary.message, MAX_MESSAGE)));
	}

	lines.push(
		'',
		'---',
		'',
		`For agents: \`get_issue\` with project \`${context.projectSlug}\` and issue \`${issue.id}\` on the Sentinel MCP has the full event.`,
	);

	return { title, description: lines.join('\n'), priority: priorityForLevel(issue.level) };
}
