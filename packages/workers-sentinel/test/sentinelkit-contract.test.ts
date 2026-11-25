import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import envelope from './fixtures/sentinelkit-handled-error.envelope?raw';
import { authFetch, createTestProject, createTestUser } from './utils';

// Contract with the iOS SDK SentinelKit (github.com/didisouzacosta/sentinel-ios).
// The fixture is a byte-for-byte copy of Tests/SentinelKitTests/Fixtures/handled-error.envelope,
// which the SDK's own tests prove it produces. If this test fails, the SDK and the server disagree:
// update both repositories together. `?raw` reads the file as a UTF-8 string, so the body stays byte-exact only
// while the fixture is valid UTF-8 (it is plain JSON lines).

const BASE = 'http://localhost';

describe('SentinelKit envelope contract', () => {
	let token: string;
	let project: Awaited<ReturnType<typeof createTestProject>>;

	beforeAll(async () => {
		const user = await createTestUser({
			email: `sentinelkit-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'SentinelKit Contract',
		});
		token = user.token!;
		project = await createTestProject(token, { name: 'SentinelKit Contract' });
	});

	it('ingests the SDK envelope and groups it as the SDK expects', async () => {
		const ingestId = new URL(project.dsn).pathname.split('/').filter(Boolean).pop()!;
		const res = await SELF.fetch(`${BASE}/api/${ingestId}/envelope/`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-sentry-envelope',
				'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=sentinel.cocoa/0.1.0, sentry_key=${project.publicKey}`,
			},
			body: envelope,
		});

		expect(res.status).toBe(200);
		expect(((await res.json()) as { id: string }).id).toBe('0123456789abcdef0123456789abcdef');

		const list = await authFetch(token, `${BASE}/api/projects/${project.slug}/issues?limit=10`);
		const { issues } = (await list.json()) as {
			issues: Array<{ title: string; culprit: string | null; level: string; platform: string }>;
		};

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			title: 'PaymentError: Card declined',
			level: 'error',
			platform: 'cocoa',
		});
		expect(issues[0].culprit).toContain('CheckoutViewModel.pay()');
	});
});
