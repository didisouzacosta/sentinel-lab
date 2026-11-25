import { readonly, ref } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

// Same key as public/theme-init.js, which applies the theme before first paint.
const STORAGE_KEY = 'sentinel-theme';

const preference = ref<ThemePreference>('system');
const resolved = ref<ResolvedTheme>('light');
let media: MediaQueryList | null = null;

function readPreference(): ThemePreference {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v === 'light' || v === 'dark' ? v : 'system';
	} catch {
		return 'system';
	}
}

function apply() {
	const systemDark = media?.matches ?? false;
	resolved.value =
		preference.value === 'system' ? (systemDark ? 'dark' : 'light') : preference.value;
	document.documentElement.dataset.theme = resolved.value;
}

/** Call once at startup: reads the saved choice and follows the OS while on "system". */
export function initTheme() {
	preference.value = readPreference();
	media =
		typeof window.matchMedia === 'function'
			? window.matchMedia('(prefers-color-scheme: dark)')
			: null;
	media?.addEventListener?.('change', () => {
		if (preference.value === 'system') apply();
	});
	apply();
}

export function useTheme() {
	function setTheme(next: ThemePreference) {
		preference.value = next;
		try {
			if (next === 'system') localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Private mode: the choice lasts for this visit only.
		}
		apply();
	}
	function toggle() {
		setTheme(resolved.value === 'dark' ? 'light' : 'dark');
	}
	return { preference: readonly(preference), theme: readonly(resolved), setTheme, toggle };
}
