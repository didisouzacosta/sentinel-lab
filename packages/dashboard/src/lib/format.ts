/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(value: string | number | Date, now: Date = new Date()): string {
	const date = new Date(value);
	const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
	return date.toLocaleDateString();
}

/** Thousands separators, matching the previous toLocaleString() output. */
export function formatNumber(value: number | null | undefined): string {
	return (value ?? 0).toLocaleString();
}
