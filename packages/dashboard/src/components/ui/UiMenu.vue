<script setup lang="ts" generic="T extends string | number">
import { Check } from 'lucide-vue-next';
import { type Component, computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';

export interface MenuItem<V> {
	value: V;
	label: string;
	icon?: Component;
	shortcut?: string;
	danger?: boolean;
	disabled?: boolean;
	/** Shows a check mark and uses role="menuitemradio" (theme, current project). */
	checked?: boolean;
	/** Small heading rendered above this item (starts a section). */
	section?: string;
	/** Draws a divider above this item. */
	separator?: boolean;
	/** Secondary line under the label. */
	description?: string;
}

const props = withDefaults(
	defineProps<{
		items: MenuItem<T>[];
		/** Small heading above the items ("SNOOZE FOR"). */
		title?: string;
		/** Accessible name of the menu. */
		label: string;
		align?: 'start' | 'end' | 'stretch';
		/** Open below (default) or above the trigger (sidebar footer). */
		placement?: 'bottom' | 'top';
		width?: number;
	}>(),
	{ align: 'end', placement: 'bottom', width: 208 },
);
const emit = defineEmits<{ select: [value: T] }>();

const open = ref(false);
const anchor = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const active = ref(-1);
const position = ref({ top: 0, left: 0, width: props.width });
const menuId = `menu-${useId()}`;
const triggerProps = computed(() => ({
	'aria-haspopup': 'menu' as const,
	'aria-expanded': open.value,
	'aria-controls': menuId,
	onClick: toggle,
}));

function place() {
	const rect = anchor.value?.getBoundingClientRect();
	if (!rect) return;
	const width = props.align === 'stretch' ? Math.max(rect.width, props.width) : props.width;
	const left = props.align === 'end' ? rect.right - width : rect.left;
	const height = panel.value?.offsetHeight ?? 0;
	const top = props.placement === 'top' ? rect.top - height - 6 : rect.bottom + 6;
	position.value = {
		top: Math.max(8, top),
		left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
		width,
	};
}

function enabledIndex(from: number, step: 1 | -1) {
	const n = props.items.length;
	for (let i = 1; i <= n; i++) {
		const idx = (from + step * i + n) % n;
		if (!props.items[idx].disabled) return idx;
	}
	return -1;
}

async function show(focus: 'first' | 'last' = 'first') {
	place();
	open.value = true;
	await nextTick();
	place(); // re-measure now that the panel has a height (placement="top")
	active.value = focus === 'last' ? enabledIndex(0, -1) : enabledIndex(-1, 1);
	focusActive();
	document.addEventListener('pointerdown', onOutside, true);
	window.addEventListener('resize', onResize);
	window.addEventListener('scroll', place, true);
}

function hide(returnFocus = true) {
	if (!open.value) return;
	open.value = false;
	document.removeEventListener('pointerdown', onOutside, true);
	window.removeEventListener('resize', onResize);
	window.removeEventListener('scroll', place, true);
	if (returnFocus) anchor.value?.querySelector<HTMLElement>('button, [href], [tabindex]')?.focus();
}

function onResize() {
	hide(false);
}

function toggle() {
	if (open.value) hide();
	else void show();
}

function onOutside(event: Event) {
	const target = event.target as Node;
	if (!panel.value?.contains(target) && !anchor.value?.contains(target)) hide(false);
}

function focusActive() {
	panel.value?.querySelectorAll<HTMLElement>('[data-menu-item]')[active.value]?.focus();
}

function choose(index: number) {
	const item = props.items[index];
	if (!item || item.disabled) return;
	hide();
	emit('select', item.value);
}

function onPanelKeydown(event: KeyboardEvent) {
	const keys: Record<string, () => void> = {
		ArrowDown: () => {
			active.value = enabledIndex(active.value, 1);
		},
		ArrowUp: () => {
			active.value = enabledIndex(active.value, -1);
		},
		Home: () => {
			active.value = enabledIndex(-1, 1);
		},
		End: () => {
			active.value = enabledIndex(0, -1);
		},
		Escape: () => hide(),
		Tab: () => hide(false),
		Enter: () => choose(active.value),
		' ': () => choose(active.value),
	};
	const fn = keys[event.key];
	if (!fn) return;
	if (event.key !== 'Tab') event.preventDefault();
	fn();
	if (open.value) focusActive();
}

function onTriggerKeydown(event: KeyboardEvent) {
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault();
		void show(event.key === 'ArrowDown' ? 'first' : 'last');
	}
}

onBeforeUnmount(() => hide(false));
defineExpose({ show, hide, toggle });
</script>

<template>
	<span ref="anchor" class="flex min-w-0" @keydown="onTriggerKeydown">
		<!-- Bind `props` on your button: aria-haspopup, aria-expanded, aria-controls, onClick -->
		<slot
			name="trigger"
			:open="open"
			:props="triggerProps"
		/>
	</span>
	<Teleport to="body">
		<Transition
			enter-from-class="opacity-0 translate-y-1"
			enter-active-class="transition duration-100 ease-out"
			leave-to-class="opacity-0"
			leave-active-class="transition duration-75 ease-in"
		>
			<div
				v-if="open"
				:id="menuId"
				ref="panel"
				role="menu"
				:aria-label="label"
				class="fixed z-50 flex max-h-[min(80dvh,560px)] flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-border-strong bg-raised p-1 shadow-overlay"
				:style="{ top: `${position.top}px`, left: `${position.left}px`, width: `${position.width}px` }"
				@keydown="onPanelKeydown"
			>
				<div v-if="$slots.header" class="mb-1 border-b border-border px-2.5 pt-2 pb-2.5" role="none">
					<slot name="header" />
				</div>
				<p v-if="title" class="px-2.5 pt-1 pb-1 text-overline text-fg-subtle uppercase" aria-hidden="true">
					{{ title }}
				</p>
				<template v-for="(item, index) in items" :key="String(item.value)">
					<div v-if="item.separator" class="my-1 h-px bg-border" role="separator" />
					<p
						v-if="item.section"
						class="px-2.5 pt-1.5 pb-1 text-overline text-fg-subtle uppercase"
						role="presentation"
					>
						{{ item.section }}
					</p>
					<button
						type="button"
						:role="item.checked !== undefined ? 'menuitemradio' : 'menuitem'"
						:aria-checked="item.checked !== undefined ? item.checked : undefined"
						tabindex="-1"
						data-menu-item
						:disabled="item.disabled"
						class="flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-body-s outline-none disabled:opacity-50"
						:class="[index === active ? 'bg-subtle' : '', item.danger ? 'text-level-error' : 'text-fg']"
						@click="choose(index)"
						@mousemove="active = index"
					>
						<component
							:is="item.icon"
							v-if="item.icon"
							:size="15"
							:class="item.danger ? '' : index === active ? 'text-accent-text' : 'text-fg-subtle'"
							aria-hidden="true"
						/>
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate">{{ item.label }}</span>
							<span v-if="item.description" class="truncate text-caption text-fg-subtle">{{
								item.description
							}}</span>
						</span>
						<Check v-if="item.checked" :size="14" class="text-accent-text" aria-hidden="true" />
						<kbd v-else-if="item.shortcut" class="font-sans text-caption text-fg-subtle">{{
							item.shortcut
						}}</kbd>
					</button>
				</template>
			</div>
		</Transition>
	</Teleport>
</template>
