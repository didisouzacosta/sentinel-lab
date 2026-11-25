import { describe, expect, it } from 'vitest';
import { getPlatform, ingestOrigin, PLATFORMS, platformForProject } from '../src/lib/platforms';

const DSN = 'https://abc123@sentinel.example.com/42';

describe('platform catalog', () => {
	it('has unique ids and stored platform values', () => {
		expect(new Set(PLATFORMS.map((p) => p.id)).size).toBe(PLATFORMS.length);
		expect(new Set(PLATFORMS.map((p) => p.projectPlatform)).size).toBe(PLATFORMS.length);
	});

	it('fills the DSN into every guide and never leaks the placeholder when one is given', () => {
		for (const guide of PLATFORMS) {
			const steps = guide.steps({ dsn: DSN });
			expect(steps.length, guide.id).toBeGreaterThan(0);
			const code = steps.map((s) => s.code).join('\n');
			expect(code, guide.id).toContain(DSN);
			expect(code, guide.id).not.toContain('<your DSN>');
			expect(code, guide.id).not.toContain('<your Sentinel');
		}
	});

	it('uses a placeholder when the DSN is unknown', () => {
		const code = getPlatform('node')
			.steps({})
			.map((s) => s.code)
			.join('\n');
		expect(code).toContain('<your DSN>');
	});

	it('marks verified entries with where they were verified', () => {
		for (const guide of PLATFORMS) {
			if (guide.support === 'verified') expect(guide.verifiedBy, guide.id).toBeTruthy();
		}
	});

	it('browser-side guides tell you to open the CSP for the ingest origin', () => {
		expect(ingestOrigin(DSN)).toBe('https://sentinel.example.com');
		for (const id of ['astro', 'envelope'] as const) {
			const code = getPlatform(id)
				.steps({ dsn: DSN })
				.map((s) => s.code)
				.join('\n');
			expect(code, id).toContain("connect-src 'self' https://sentinel.example.com");
		}
	});

	it('maps stored project platforms to a guide', () => {
		const cases: Array<[string | null | undefined, string]> = [
			[undefined, 'browser'],
			['javascript', 'browser'],
			['javascript-react', 'browser'], // contains "java": must not become Android
			['javascript-astro', 'astro'],
			['node', 'node'],
			['node-express', 'node'],
			['cloudflare-workers', 'cloudflare-workers'],
			['node-cloudflare-workers', 'cloudflare-workers'],
			['deno', 'deno'],
			['bun', 'bun'],
			['python-django', 'python'],
			['php-laravel', 'php'],
			['cocoa', 'ios'],
			['apple-ios', 'ios'],
			['android', 'android'],
			['java', 'android'],
			['envelope', 'envelope'],
			['ruby', 'other'],
			['go', 'other'],
		];
		for (const [stored, expected] of cases) {
			expect(platformForProject(stored), String(stored)).toBe(expected);
		}
	});
});
