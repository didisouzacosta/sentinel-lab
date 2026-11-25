/**
 * Short summary of a stored Sentry event: exception type and message, stack
 * frames innermost first (app frames marked `[app]`), tags, environment,
 * release and the last breadcrumbs. Shared by the MCP `get_issue` tool and
 * the Kaneo task body.
 */
export function summarizeEvent(event: Record<string, unknown>) {
	const exception =
		(event.exception as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? [];
	const exceptions = exception.map((value) => {
		const frames = (
			(value.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined)?.frames ?? []
		)
			.slice()
			.reverse() // innermost first
			.slice(0, 20)
			.map((f) => {
				const where = [f.filename ?? f.abs_path ?? f.module, f.lineno, f.colno]
					.filter((x) => x !== undefined)
					.join(':');
				return `${f.in_app ? '[app] ' : ''}${f.function ?? '?'}${where ? ` (${where})` : ''}`;
			});
		return { type: value.type, value: value.value, mechanism: value.mechanism, frames };
	});
	const breadcrumbs = ((event.breadcrumbs as { values?: unknown[] } | unknown[] | undefined) ??
		[]) as { values?: unknown[] } | unknown[];
	const crumbList = Array.isArray(breadcrumbs) ? breadcrumbs : (breadcrumbs.values ?? []);
	return {
		eventId: event.event_id,
		timestamp: event.timestamp,
		level: event.level,
		platform: event.platform,
		environment: event.environment,
		release: event.release,
		message: (event.logentry as { formatted?: string } | undefined)?.formatted ?? event.message,
		exceptions,
		tags: event.tags,
		request: event.request
			? {
					url: (event.request as { url?: string }).url,
					method: (event.request as { method?: string }).method,
				}
			: undefined,
		user: event.user ? { id: (event.user as { id?: string }).id } : undefined,
		lastBreadcrumbs: crumbList.slice(-10),
		sdk: event.sdk,
	};
}

export type EventSummary = ReturnType<typeof summarizeEvent>;
