<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next';
import UiButton from '../ui/UiButton.vue';
import UiTag from '../ui/UiTag.vue';

/** A stored file (source map, dSYM, mapping): tag, name, meta line and an optional delete action. */
defineProps<{
	tag: string;
	name: string;
	meta: string;
	/** Shown and announced as the delete button's label when the row can be deleted. */
	deleteLabel?: string;
	testId?: string;
}>();
defineEmits<{ delete: [] }>();
</script>

<template>
	<li class="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0" :data-testid="testId">
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-2">
				<UiTag>{{ tag }}</UiTag>
				<span class="min-w-0 truncate font-mono text-body-s text-fg" :title="name">{{ name }}</span>
			</div>
			<p class="mt-0.5 text-caption text-fg-subtle" data-numeric>{{ meta }}</p>
		</div>
		<UiButton
			v-if="deleteLabel"
			variant="ghost"
			size="icon-sm"
			:icon="Trash2"
			:aria-label="deleteLabel"
			@click="$emit('delete')"
		/>
	</li>
</template>
