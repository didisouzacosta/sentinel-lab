<script setup lang="ts">
import { Activity } from 'lucide-vue-next';
import UiBadge from '../ui/UiBadge.vue';

// Decorative sample shown on the brand panel (never real data).
const sample = [
	{
		level: 'fatal',
		type: 'OutOfMemoryError',
		message: 'Worker exceeded memory limit',
		when: 'now',
	},
	{
		level: 'error',
		type: 'TypeError',
		message: 'Cannot read properties of undefined',
		when: '12s',
	},
	{ level: 'warning', type: 'DeprecationWarning', message: 'Buffer() is deprecated', when: '1m' },
];
</script>

<template>
	<!-- Two columns on desktop (brand panel + form); form only on phones/tablets.
	     The brand panel is not an <aside>: the app shell owns that landmark. -->
	<div class="flex min-h-dvh bg-canvas text-fg">
		<section
			aria-label="About Sentinel"
			class="hidden w-[44%] max-w-[640px] flex-col justify-between border-r border-border bg-sidebar px-16 py-14 lg:flex"
		>
			<div class="flex items-center gap-2.5">
				<span class="flex size-8 items-center justify-center rounded-lg bg-accent text-heading-m text-accent-fg">S</span>
				<span class="text-heading-m text-fg">Sentinel</span>
			</div>
			<div class="flex max-w-[480px] flex-col gap-4">
				<p class="text-display text-fg">Error tracking that lives on your edge.</p>
				<p class="text-body text-fg-muted">
					Sentry-compatible ingestion stored in Durable Objects, self-hosted on Cloudflare Workers.
				</p>
				<div class="overflow-hidden rounded-[10px] border border-border bg-surface" aria-hidden="true">
					<div class="flex items-center gap-2 border-b border-border px-4 py-3">
						<Activity :size="14" class="text-accent-text" />
						<span class="flex-1 text-caption text-fg-muted">Live events</span>
						<span class="font-mono text-caption text-fg-subtle">production</span>
					</div>
					<div
						v-for="row in sample"
						:key="row.type"
						class="flex items-center gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0"
					>
						<UiBadge :level="row.level" />
						<span class="text-body-s font-medium text-fg">{{ row.type }}</span>
						<span class="min-w-0 flex-1 truncate text-body-s text-fg-muted">{{ row.message }}</span>
						<span class="text-caption text-fg-subtle">{{ row.when }}</span>
					</div>
				</div>
			</div>
			<p class="text-caption text-fg-subtle">Workers Sentinel · self-hosted</p>
		</section>

		<main class="flex flex-1 items-center justify-center px-6 py-12">
			<div class="flex w-full max-w-[360px] flex-col gap-5">
				<div class="flex items-center gap-2.5 lg:hidden">
					<span class="flex size-8 items-center justify-center rounded-lg bg-accent text-heading-m text-accent-fg">S</span>
					<span class="text-heading-m text-fg">Sentinel</span>
				</div>
				<slot />
			</div>
		</main>
	</div>
</template>
