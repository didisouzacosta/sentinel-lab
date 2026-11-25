// Applies the saved theme (or the system one) before the app renders, so there
// is no light/dark flash. Kept in sync with src/composables/useTheme.ts.
(() => {
	const KEY = 'sentinel-theme';
	let pref = 'system';
	try {
		pref = localStorage.getItem(KEY) || 'system';
	} catch {}
	const dark =
		pref === 'dark' ||
		(pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
