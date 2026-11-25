export interface TrendPoint {
	bucket: string;
	count: number;
}

const HOUR = 3_600_000;

/**
 * The summary API only returns hours that had events. Charts need the whole
 * window, so this expands it to one bucket per hour (zero when empty), ending
 * at the current hour.
 */
export function fillHourly(
	points: TrendPoint[],
	hours = 168,
	now: Date = new Date(),
): TrendPoint[] {
	const counts = new Map<number, number>();
	for (const p of points) {
		const key = Math.floor(new Date(p.bucket).getTime() / HOUR);
		counts.set(key, (counts.get(key) ?? 0) + p.count);
	}
	const end = Math.floor(now.getTime() / HOUR);
	const out: TrendPoint[] = [];
	for (let key = end - hours + 1; key <= end; key++) {
		out.push({ bucket: new Date(key * HOUR).toISOString(), count: counts.get(key) ?? 0 });
	}
	return out;
}
