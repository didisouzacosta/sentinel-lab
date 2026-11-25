import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards WCAG AA (4.5:1) for every text/background pair the design system uses,
// in both themes, straight from the tokens in style.css.
const css = readFileSync(resolve(__dirname, '../style.css'), 'utf8');

function block(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	const body = css.slice(start, css.indexOf('}', start));
	return Object.fromEntries(
		[...body.matchAll(/--sn-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]),
	);
}

function luminance(hex: string) {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const PAIRS: [string, string][] = [
	['fg', 'canvas'],
	['fg', 'surface'],
	['fg-muted', 'surface'],
	['fg-muted', 'raised'],
	['fg-subtle', 'canvas'],
	['fg-subtle', 'surface'],
	['fg-subtle', 'raised'],
	['fg-subtle', 'sidebar'],
	['accent-fg', 'accent'],
	['accent-fg', 'accent-hover'],
	['accent-text', 'accent-subtle'],
	['accent-text', 'surface'],
	['fatal', 'fatal-bg'],
	['error', 'error-bg'],
	['warning', 'warning-bg'],
	['info', 'info-bg'],
	['debug', 'debug-bg'],
	['success', 'success-bg'],
];

describe.each([
	['light', ':root'],
	['dark', '[data-theme="dark"]'],
])('%s theme tokens', (_name, selector) => {
	const tokens = block(selector);

	it('defines every semantic token', () => {
		for (const [fg, bg] of PAIRS) {
			expect(tokens[fg], fg).toMatch(/^#/);
			expect(tokens[bg], bg).toMatch(/^#/);
		}
	});

	it.each(PAIRS)('%s on %s meets WCAG AA', (fg, bg) => {
		expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
	});
});
