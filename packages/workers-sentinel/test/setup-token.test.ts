import { describe, expect, it } from 'vitest';
import { firstRegistrationRefusal } from '../src/lib/setup-token';

describe('first registration gate', () => {
	const base = { isFirstUser: true, host: 'sentinel.example.com' };

	it('lets later registrations through whatever the token', () => {
		expect(
			firstRegistrationRefusal({ ...base, isFirstUser: false, host: 'x.y.workers.dev' }),
		).toBeNull();
		expect(
			firstRegistrationRefusal({ ...base, isFirstUser: false, envSetupToken: 'secret' }),
		).toBeNull();
	});

	it('requires the configured token for the first registration', () => {
		expect(firstRegistrationRefusal({ ...base, envSetupToken: 'secret' })?.error).toBe(
			'setup_token_required',
		);
		expect(
			firstRegistrationRefusal({ ...base, envSetupToken: 'secret', setupToken: 'wrong' })?.error,
		).toBe('setup_token_required');
		expect(
			firstRegistrationRefusal({ ...base, envSetupToken: 'secret', setupToken: 'secret' }),
		).toBeNull();
	});

	it('keeps the open bootstrap on a custom domain or locally when no token is set', () => {
		expect(firstRegistrationRefusal(base)).toBeNull();
		expect(firstRegistrationRefusal({ ...base, host: 'localhost' })).toBeNull();
		expect(firstRegistrationRefusal({ ...base, host: undefined })).toBeNull();
	});

	it('refuses the first registration on workers.dev when no token is set', () => {
		// A fresh Deploy to Cloudflare install lives on workers.dev: without a token,
		// whoever finds the address first would become the admin.
		const refusal = firstRegistrationRefusal({ ...base, host: 'sentinel.me.workers.dev' });
		expect(refusal?.error).toBe('setup_token_unset');
		expect(refusal?.message).toMatch(/SETUP_TOKEN/);
		expect(firstRegistrationRefusal({ ...base, host: 'SENTINEL.ME.WORKERS.DEV' })?.error).toBe(
			'setup_token_unset',
		);
	});

	it('treats an empty or blank token as unset', () => {
		expect(
			firstRegistrationRefusal({ ...base, host: 'a.b.workers.dev', envSetupToken: '  ' })?.error,
		).toBe('setup_token_unset');
		expect(firstRegistrationRefusal({ ...base, envSetupToken: '' })).toBeNull();
	});

	it('does not mistake a look-alike host for workers.dev', () => {
		expect(firstRegistrationRefusal({ ...base, host: 'evilworkers.dev' })).toBeNull();
		expect(firstRegistrationRefusal({ ...base, host: 'workers.dev.example.com' })).toBeNull();
	});
});
