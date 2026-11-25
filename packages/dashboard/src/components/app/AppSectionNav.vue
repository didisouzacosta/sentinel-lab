<script setup lang="ts">
// In-page section navigation for long settings pages (Figma: App/Subnav).
// Highlights the section in view and scrolls smoothly to the one picked;
// the heading of the target section receives focus for keyboard users.
import { onBeforeUnmount, onMounted, ref } from 'vue';

export interface SectionNavItem {
	id: string;
	label: string;
	danger?: boolean;
}

const props = defineProps<{ items: SectionNavItem[]; label?: string }>();

const active = ref(props.items[0]?.id ?? '');
let observer: IntersectionObserver | undefined;
// After a click the smooth scroll passes other sections (and may stop short at
// the end of the page); keep the picked item highlighted meanwhile.
let lockedUntil = 0;
const inView = new Set<string>();

function go(id: string) {
	const el = document.getElementById(id);
	if (!el) return;
	active.value = id;
	lockedUntil = Date.now() + 1000;
	el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	const heading = el.querySelector<HTMLElement>('h2, h3');
	if (heading) {
		heading.tabIndex = -1;
		heading.focus({ preventScroll: true });
	}
}

onMounted(() => {
	if (typeof IntersectionObserver === 'undefined') return;
	observer = new IntersectionObserver(
		(entries) => {
			// Entries only carry the sections whose visibility changed; keep the
			// full set and highlight the first visible one in page order.
			for (const e of entries) {
				if (e.isIntersecting) inView.add(e.target.id);
				else inView.delete(e.target.id);
			}
			if (Date.now() < lockedUntil) return;
			const first = props.items.find((item) => inView.has(item.id));
			if (first) active.value = first.id;
		},
		{ rootMargin: '-10% 0px -70% 0px' },
	);
	for (const item of props.items) {
		const el = document.getElementById(item.id);
		if (el) observer.observe(el);
	}
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<nav :aria-label="label ?? 'Sections'">
		<ul class="flex flex-col gap-0.5">
			<li v-for="item in items" :key="item.id">
				<a
					:href="`#${item.id}`"
					class="block rounded-md px-3 py-1.5 text-body-s transition-colors"
					:class="[
						active === item.id ? 'bg-subtle font-medium' : 'hover:bg-subtle/60',
						item.danger ? 'text-level-error' : active === item.id ? 'text-fg' : 'text-fg-muted hover:text-fg',
					]"
					:aria-current="active === item.id ? 'location' : undefined"
					@click.prevent="go(item.id)"
				>{{ item.label }}</a>
			</li>
		</ul>
	</nav>
</template>
