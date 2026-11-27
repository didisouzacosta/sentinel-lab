<script setup lang="ts">
import type { DebugPlatform } from '../../lib/debug-files';
import UiCode from '../ui/UiCode.vue';

/** How to get a platform's debug file, with the terminal command. */
const props = defineProps<{ platform: DebugPlatform }>();

const CONTENT: Record<DebugPlatform, { title: string; steps: string[]; command: string }> = {
	ios: {
		title: 'How to get your dSYMs',
		steps: [
			'Release builds need Debug Information Format set to “DWARF with dSYM File” (Xcode’s default for Release).',
			'After Product → Archive, open the Organizer, right-click the archive → Show in Finder → Show Package Contents → dSYMs.',
			'Upload the file inside MyApp.app.dSYM/Contents/Resources/DWARF/ here, or every dSYM of the archive from the terminal:',
		],
		command: 'sentry-cli debug-files upload --wait MyApp.xcarchive/dSYMs',
	},
	android: {
		title: 'How to get your mapping',
		steps: [
			'With minifyEnabled true, R8 writes app/build/outputs/mapping/release/mapping.txt on every release build.',
			'Crashes name the mapping by a UUID: copy it from io.sentry.ProguardUuids in app/build/intermediates/assets/release/sentry-debug-meta.properties.',
			'Upload mapping.txt here with that UUID, or let the Sentry Gradle plugin do it (autoUploadProguardMapping), or:',
		],
		command:
			'sentry-cli upload-proguard --uuid <UUID> app/build/outputs/mapping/release/mapping.txt',
	},
};
const content = CONTENT[props.platform];
</script>

<template>
	<section class="flex flex-col gap-2.5 rounded-lg border border-border bg-raised p-3.5" :aria-label="content.title">
		<h3 class="text-body-s font-medium text-fg">{{ content.title }}</h3>
		<ol class="flex flex-col gap-2">
			<li v-for="(step, index) in content.steps" :key="index" class="flex gap-2.5 text-body-s text-fg-muted">
				<span
					class="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption text-accent-text"
					aria-hidden="true"
				>{{ index + 1 }}</span>
				<span class="min-w-0 break-words">{{ step }}</span>
			</li>
		</ol>
		<UiCode :code="content.command" language="Terminal" />
	</section>
</template>
