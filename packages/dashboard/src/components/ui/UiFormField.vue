<script setup lang="ts">
import { CircleAlert } from 'lucide-vue-next';
import { computed, useId } from 'vue';

const props = defineProps<{
	label: string;
	help?: string;
	/** Error message; marks the control invalid and announces it. */
	error?: string | null;
	required?: boolean;
	/** Use a known id (e.g. tests rely on #email); generated otherwise. */
	id?: string;
}>();

const generated = useId();
const controlId = computed(() => props.id ?? `field-${generated}`);
const messageId = computed(() => `${controlId.value}-message`);
const describedBy = computed(() => (props.error || props.help ? messageId.value : undefined));
</script>

<template>
	<div class="flex flex-col gap-1.5">
		<label :for="controlId" class="text-body-s font-medium text-fg">
			{{ label }}
			<span v-if="required" class="text-level-error" aria-hidden="true">*</span>
		</label>
		<!-- Bind these on the control: id, aria-describedby, invalid -->
		<slot :id="controlId" :described-by="describedBy" :invalid="!!error" />
		<p
			v-if="error"
			:id="messageId"
			class="flex items-center gap-1.5 text-caption text-level-error"
			role="alert"
		>
			<CircleAlert :size="14" aria-hidden="true" />
			{{ error }}
		</p>
		<p v-else-if="help" :id="messageId" class="text-caption text-fg-subtle">{{ help }}</p>
	</div>
</template>
