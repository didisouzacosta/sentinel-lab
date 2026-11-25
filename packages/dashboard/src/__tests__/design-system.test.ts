import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Standardization guard (plan §3.1): screens compose design-system components and
 * tokens only. A migrated file must not use raw palette colors, hex colors, inline
 * SVG, hand-rolled overlays or the browser's confirm()/alert().
 *
 * LEGACY lists files not migrated yet. Each stage removes its files from the list;
 * the list must be empty at stage 11. A file on the list that is already clean
 * fails the test, so the list can only shrink.
 */
const LEGACY = new Set<string>([]);

const RULES: [string, RegExp][] = [
	[
		'raw palette color (use a semantic token such as bg-surface, text-fg-muted)',
		/\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|placeholder|accent|decoration)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|error|warning)-\d{2,3}\b/,
	],
	['hex color (use a token)', /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])/],
	// Charts draw SVG on purpose and opt out with data-chart; icons must come from lucide.
	['inline <svg> icon (use a lucide-vue-next icon)', /<svg(?![^>]*\bdata-chart\b)[\s>]/],
	['hand-rolled overlay (use UiDialog / UiDrawer)', /fixed inset-0/],
	['window.confirm() (use useConfirm)', /(?<![\w.])confirm\(/],
	['window.alert() (use useToast)', /(?<![\w.])alert\(/],
	[
		'legacy alias class (use the Ui* component)',
		/\bclass="[^"]*\b(?:btn|btn-primary|btn-secondary|btn-danger|input|card|badge|label)\b[^"]*"/,
	],
];

const SRC = resolve(__dirname, '..');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
		return path.endsWith('.vue') ? [path] : [];
	});
}

function violations(path: string): string[] {
	const text = readFileSync(path, 'utf8')
		// Comments may mention the forbidden patterns.
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	return RULES.filter(([, re]) => re.test(text)).map(([why]) => why);
}

describe('design-system standardization guard', () => {
	const all = files(SRC).map((p) => relative(SRC, p));

	it.each(
		all.filter((f) => !LEGACY.has(f)),
	)('%s uses only design-system components and tokens', (file) => {
		expect(violations(join(SRC, file))).toEqual([]);
	});

	it('legacy list only holds files that still need migrating', () => {
		const clean = [...LEGACY].filter(
			(f) => all.includes(f) && violations(join(SRC, f)).length === 0,
		);
		expect(clean, 'remove these from LEGACY — they are migrated').toEqual([]);
		const missing = [...LEGACY].filter((f) => !all.includes(f));
		expect(missing, 'remove deleted files from LEGACY').toEqual([]);
	});
});

describe('style.css only defines design-system colors', () => {
	const css = readFileSync(join(SRC, 'style.css'), 'utf8');

	it('switches off the default Tailwind palette', () => {
		expect(css).toMatch(/--color-\*:\s*initial;/);
	});

	it('has no legacy palettes or alias classes', () => {
		expect(css).not.toMatch(/--color-(?:primary|error|warning|gray|sky)-\d/);
		expect(css).not.toMatch(/^\s*\.(?:btn|card|input|label|badge)[\w-]*\s*\{/m);
	});
});
