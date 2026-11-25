/**
 * "Export" on the issue page: everything the page shows about an issue, as
 * one JSON document meant to be pasted into an AI assistant (or attached to
 * a ticket). The selected event goes in whole — exception with frames and
 * code context, breadcrumbs, tags, contexts, request, SDK — exactly as
 * stored; nothing is summarized away.
 */

export const ISSUE_EXPORT_FORMAT = 'sentinel.issue-export/v1';

export interface ExportResolvedFrame {
	originalFilename: string | null;
	originalFunction: string | null;
	originalLineno: number | null;
	originalColno: number | null;
	resolved: boolean;
}

export interface IssueExportInput {
	project: { slug: string; name?: string };
	issue: Record<string, unknown> & { id: string };
	/** The event the page is showing, as returned by the API (full raw event). */
	event: (Record<string, unknown> & { event_id: string }) | null;
	/** Every event the page loaded (the selector); only ids/time/env/release are exported. */
	events: Array<Record<string, unknown> & { event_id: string }>;
	/** Source-mapped frames keyed by display index (innermost frame = 0). */
	resolvedFrames?: Map<number, ExportResolvedFrame>;
	activity?: Array<Record<string, unknown>>;
	/** Absolute dashboard URL of the issue. */
	issueUrl: string;
	exportedAt?: Date;
}

const README =
	'Error report exported from Sentinel, a self-hosted Sentry-compatible error tracker. ' +
	'"issue" is the grouped problem; "event" is one full occurrence as the SDK sent it (Sentry event format). ' +
	"In event.exception.values[].stacktrace.frames the LAST frame is where the error was thrown; in_app marks the app's own code. " +
	'"sourceMappedFrames" (when present) gives original file/line for minified frames, innermost first. ' +
	'Find the root cause and propose a fix.';

export function buildIssueExport(input: IssueExportInput) {
	const resolved = input.resolvedFrames
		? [...input.resolvedFrames.entries()]
				.filter(([, frame]) => frame.resolved)
				.sort(([a], [b]) => a - b)
				.map(([index, frame]) => ({
					frameFromTop: index,
					file: frame.originalFilename,
					function: frame.originalFunction,
					line: frame.originalLineno,
					column: frame.originalColno,
				}))
		: [];

	return {
		format: ISSUE_EXPORT_FORMAT,
		readme: README,
		exportedAt: (input.exportedAt ?? new Date()).toISOString(),
		project: input.project,
		issue: { ...input.issue, url: input.issueUrl },
		event: input.event,
		...(resolved.length > 0 ? { sourceMappedFrames: resolved } : {}),
		otherEvents: input.events
			.filter((e) => e.event_id !== input.event?.event_id)
			.map((e) => ({
				event_id: e.event_id,
				timestamp: e.timestamp,
				environment: e.environment,
				release: e.release,
			})),
		activity: (input.activity ?? []).map((a) => ({
			type: a.type,
			by: a.userName,
			at: a.createdAt,
			data: a.data,
		})),
	};
}

export function issueExportJson(input: IssueExportInput): string {
	return JSON.stringify(buildIssueExport(input), null, 2);
}

/** `sentinel-<project>-<issue id prefix>.json` */
export function issueExportFilename(projectSlug: string, issueId: string): string {
	const safe = projectSlug.replace(/[^a-z0-9-]/gi, '-');
	return `sentinel-${safe}-${issueId.slice(0, 8)}.json`;
}
