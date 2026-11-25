<script setup lang="ts">
import { computed, ref } from 'vue';

import type { TrendPoint } from '../../lib/trend';

const props = withDefaults(
	defineProps<{ points: TrendPoint[]; label?: string; height?: number }>(),
	{
		label: 'Events over time',
		height: 180,
	},
);

const active = ref<number | null>(null);

const max = computed(() => Math.max(0, ...props.points.map((p) => p.count)));
// Round the axis up to a friendly number so the gridlines read well.
const axisMax = computed(() => {
	const m = max.value;
	if (m <= 4) return 4;
	const magnitude = 10 ** Math.floor(Math.log10(m));
	const step = magnitude / 2;
	return Math.ceil(m / step) * step;
});

const W = 1000; // viewBox width; the SVG scales to the container
const gap = computed(() => (props.points.length > 60 ? 1.5 : 4));
const barWidth = computed(() => Math.max(1, W / Math.max(1, props.points.length) - gap.value));
const bars = computed(() =>
	props.points.map((p, i) => {
		const h = axisMax.value ? (p.count / axisMax.value) * props.height : 0;
		const height = p.count > 0 ? Math.max(h, 2) : 0;
		return { x: i * (W / props.points.length), y: props.height - height, height, point: p };
	}),
);

const peak = computed(() => {
	let best: TrendPoint | null = null;
	for (const p of props.points) if (!best || p.count > best.count) best = p;
	return best;
});

// X axis: one label per calendar day.
const dayTicks = computed(() => {
	const seen = new Set<string>();
	const ticks: { index: number; label: string }[] = [];
	props.points.forEach((p, i) => {
		const d = new Date(p.bucket);
		const key = d.toDateString();
		if (!seen.has(key)) {
			seen.add(key);
			ticks.push({
				index: i,
				label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
			});
		}
	});
	// Drop a label that would sit on top of the next one (partial first day).
	const minGap = props.points.length * 0.06;
	return ticks.filter((t, i) => !ticks[i + 1] || ticks[i + 1].index - t.index >= minGap);
});

// Screen-reader summary: totals per day.
const dailyTotals = computed(() => {
	const map = new Map<string, number>();
	for (const p of props.points) {
		const key = new Date(p.bucket).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		map.set(key, (map.get(key) ?? 0) + p.count);
	}
	return [...map.entries()];
});

function formatBucket(bucket: string) {
	return new Date(bucket).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

const plot = ref<HTMLElement | null>(null);
function onPointerMove(event: PointerEvent) {
	const rect = plot.value?.getBoundingClientRect();
	if (!rect || !props.points.length) return;
	const ratio = (event.clientX - rect.left) / rect.width;
	active.value = Math.min(
		props.points.length - 1,
		Math.max(0, Math.floor(ratio * props.points.length)),
	);
}
// Keyboard: the chart is one tab stop; arrows move between buckets.
function onKeydown(event: KeyboardEvent) {
	if (!props.points.length) return;
	const last = props.points.length - 1;
	const current = active.value ?? last;
	const next =
		event.key === 'ArrowRight'
			? Math.min(last, current + 1)
			: event.key === 'ArrowLeft'
				? Math.max(0, current - 1)
				: event.key === 'Home'
					? 0
					: event.key === 'End'
						? last
						: null;
	if (next === null) return;
	event.preventDefault();
	active.value = next;
}

const tooltipLeft = computed(() =>
	active.value === null ? 0 : ((active.value + 0.5) / props.points.length) * 100,
);
// Keep the tooltip inside the card near the edges.
const tooltipShift = computed(() =>
	tooltipLeft.value > 85 ? '-100% -100%' : tooltipLeft.value < 15 ? '0 -100%' : '-50% -100%',
);
const activePoint = computed(() => (active.value === null ? null : props.points[active.value]));
defineExpose({ peak });
</script>

<template>
	<figure class="flex flex-col gap-2">
		<div class="flex gap-3">
			<div class="flex w-8 shrink-0 flex-col justify-between text-right text-caption text-fg-subtle" :style="{ height: `${height}px` }" aria-hidden="true">
				<span data-numeric>{{ axisMax.toLocaleString() }}</span>
				<span data-numeric>{{ (axisMax / 2).toLocaleString() }}</span>
				<span>0</span>
			</div>
			<div
				ref="plot"
				class="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-accent/40"
				:style="{ height: `${height}px` }"
				role="group"
				aria-roledescription="chart"
				tabindex="0"
				:aria-label="`${label}. Peak ${peak?.count ?? 0} events. Use the arrow keys to read each bucket.`"
				data-testid="trend-chart"
				@pointermove="onPointerMove"
				@pointerleave="active = null"
				@keydown="onKeydown"
				@blur="active = null"
			>
				<svg data-chart :viewBox="`0 0 ${W} ${height}`" preserveAspectRatio="none" class="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
					<line v-for="y in [0, height / 2, height - 0.5]" :key="y" x1="0" :x2="W" :y1="y" :y2="y" class="stroke-border" stroke-width="1" vector-effect="non-scaling-stroke" />
					<rect
						v-for="(bar, i) in bars"
						:key="bar.point.bucket"
						:x="bar.x"
						:y="bar.y"
						:width="barWidth"
						:height="bar.height"
						rx="1"
						:class="i === active ? 'fill-accent-hover' : 'fill-accent opacity-75'"
					/>
				</svg>
				<div
					v-if="activePoint"
					class="pointer-events-none absolute -top-2 z-10 rounded-md border border-border-strong bg-raised px-2.5 py-1.5 whitespace-nowrap shadow-overlay"
					:style="{ left: `${tooltipLeft}%`, translate: tooltipShift }"
					aria-hidden="true"
				>
					<span class="block text-caption text-fg-muted">{{ formatBucket(activePoint.bucket) }}</span>
					<span class="block text-body-s font-medium text-fg" data-numeric>
						{{ activePoint.count.toLocaleString() }} event{{ activePoint.count === 1 ? '' : 's' }}
					</span>
				</div>
			</div>
		</div>
		<p class="sr-only" aria-live="polite">
			{{ activePoint ? `${formatBucket(activePoint.bucket)}: ${activePoint.count} events` : '' }}
		</p>
		<div class="relative ml-11 h-4 text-caption text-fg-subtle" aria-hidden="true">
			<span
				v-for="(tick, i) in dayTicks"
				:key="tick.label"
				class="absolute -translate-x-0"
				:class="i % 2 === 1 ? 'hidden sm:inline' : ''"
				:style="{ left: `${(tick.index / points.length) * 100}%` }"
			>
				{{ tick.label }}
			</span>
		</div>
		<table class="sr-only">
			<caption>{{ label }} — totals per day</caption>
			<thead>
				<tr><th scope="col">Day</th><th scope="col">Events</th></tr>
			</thead>
			<tbody>
				<tr v-for="[day, total] in dailyTotals" :key="day">
					<td>{{ day }}</td>
					<td>{{ total }}</td>
				</tr>
			</tbody>
		</table>
	</figure>
</template>
