import type { RouteLocationRaw } from 'vue-router';

/**
 * Debug files in the dashboard: iOS dSYMs (`macho`) and Android ProGuard/R8
 * mappings (`proguard`), the platform each belongs to, and the link from a
 * crash that lacks one to the upload tab in Project settings.
 */

export type DebugFileKind = 'macho' | 'proguard';
export type DebugPlatform = 'ios' | 'android';

export interface MissingDebugFile {
	debugId: string;
	kind: DebugFileKind;
	image: string | null;
}

export function platformOf(kind: DebugFileKind | null | undefined): DebugPlatform {
	return kind === 'proguard' ? 'android' : 'ios';
}

export const MISSING_LABEL: Record<DebugPlatform, string> = {
	ios: 'dSYM missing',
	android: 'Mapping missing',
};

export const FILE_NOUN: Record<DebugPlatform, string> = {
	ios: 'dSYM',
	android: 'mapping',
};

/** Project settings → Debug files, on the file's platform tab, naming what is missing. */
export function uploadLink(
	slug: string,
	file: Pick<MissingDebugFile, 'kind' | 'debugId'>,
	issueId?: string,
): RouteLocationRaw {
	return {
		name: 'project-settings',
		params: { slug },
		query: {
			debugFiles: platformOf(file.kind),
			debugId: file.debugId,
			...(issueId ? { issue: issueId } : {}),
		},
		hash: '#debug-files',
	};
}

/** The first missing file per platform (one tag per platform). */
export function missingByPlatform(files: MissingDebugFile[] | undefined): MissingDebugFile[] {
	const seen = new Set<DebugPlatform>();
	const out: MissingDebugFile[] = [];
	for (const file of files ?? []) {
		const platform = platformOf(file.kind);
		if (seen.has(platform)) continue;
		seen.add(platform);
		out.push(file);
	}
	return out;
}
