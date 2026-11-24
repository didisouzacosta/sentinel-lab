import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { trimFrames } from '../src/lib/envelope-parser';
import { authFetch, createTestProject, createTestUser } from './utils';

// Sentinel Lab: compatibility fixes for the official Sentry SDKs.

const BASE = 'http://localhost';

function envelopeOf(items: Array<{ header: Record<string, unknown>; payload: unknown }>): string {
	const lines = [JSON.stringify({ event_id: crypto.randomUUID().replace(/-/g, '') })];
	for (const item of items) {
		lines.push(JSON.stringify(item.header), JSON.stringify(item.payload));
	}
	return lines.join('\n');
}

function errorEvent(extra: Record<string, unknown> = {}) {
	return {
		event_id: crypto.randomUUID().replace(/-/g, ''),
		timestamp: new Date().toISOString(),
		platform: 'javascript',
		level: 'error',
		exception: { values: [{ type: 'LabError', value: `lab ${crypto.randomUUID()}` }] },
		...extra,
	};
}

function transactionEvent() {
	return {
		event_id: crypto.randomUUID().replace(/-/g, ''),
		type: 'transaction',
		transaction: 'POST /checkout',
		start_timestamp: Date.now() / 1000 - 1,
		timestamp: Date.now() / 1000,
		contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), op: 'http.server' } },
		spans: [],
	};
}

async function post(path: string, publicKey: string, body: string): Promise<Response> {
	return SELF.fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
		},
		body,
	});
}

describe('Lab: Sentry SDK compatibility', () => {
	let token: string;
	let project: Awaited<ReturnType<typeof createTestProject>>;
	let other: Awaited<ReturnType<typeof createTestProject>>;
	let ingestId: string;

	beforeAll(async () => {
		const user = await createTestUser({
			email: `lab-compat-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Lab Compat',
		});
		token = user.token!;
		project = await createTestProject(token, { name: 'Lab Compat Project' });
		other = await createTestProject(token, { name: 'Lab Compat Other' });
		ingestId = new URL(project.dsn).pathname.split('/').filter(Boolean).pop()!;
	});

	async function issueTitles(slug: string): Promise<string[]> {
		const res = await authFetch(token, `${BASE}/api/projects/${slug}/issues?limit=100`);
		const data = (await res.json()) as { issues: Array<{ title: string }> };
		return data.issues.map((i) => i.title);
	}

	describe('numeric DSN project id (bug 1)', () => {
		it('issues DSNs with a numeric project id the SDKs accept', () => {
			expect(ingestId).toMatch(/^\d+$/);
			expect(ingestId).not.toBe(project.id);
		});

		it('ingests through the numeric id', async () => {
			const event = errorEvent();
			const res = await post(
				`/api/${ingestId}/envelope/`,
				project.publicKey,
				envelopeOf([{ header: { type: 'event' }, payload: event }]),
			);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { id: string }).id).toBe(event.event_id);
		});

		it('keeps accepting legacy UUID DSNs', async () => {
			const res = await post(
				`/api/${project.id}/envelope/`,
				project.publicKey,
				envelopeOf([{ header: { type: 'event' }, payload: errorEvent() }]),
			);
			expect(res.status).toBe(200);
		});

		it("rejects another project's numeric id with this key", async () => {
			const otherIngestId = new URL(other.dsn).pathname.split('/').filter(Boolean).pop()!;
			expect(otherIngestId).not.toBe(ingestId);
			const res = await post(
				`/api/${otherIngestId}/envelope/`,
				project.publicKey,
				envelopeOf([{ header: { type: 'event' }, payload: errorEvent() }]),
			);
			expect(res.status).toBe(400);
		});
	});

	describe('transactions are not error issues (bug 2)', () => {
		it('drops a transaction-only envelope without creating an issue', async () => {
			const res = await post(
				`/api/${ingestId}/envelope/`,
				project.publicKey,
				envelopeOf([{ header: { type: 'transaction' }, payload: transactionEvent() }]),
			);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { id: string | null }).id).toBeNull();
			expect(await issueTitles(project.slug)).not.toContain('Unknown Error');
		});

		it('keeps the error when an envelope mixes an event and a transaction', async () => {
			const event = errorEvent();
			const res = await post(
				`/api/${ingestId}/envelope/`,
				project.publicKey,
				envelopeOf([
					{ header: { type: 'transaction' }, payload: transactionEvent() },
					{ header: { type: 'event' }, payload: event },
				]),
			);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { id: string }).id).toBe(event.event_id);
		});

		it('drops a transaction posted to the legacy store endpoint', async () => {
			const res = await post(
				`/api/${ingestId}/store/`,
				project.publicKey,
				JSON.stringify(transactionEvent()),
			);
			expect(res.status).toBe(200);
			expect(((await res.json()) as { id: string | null }).id).toBeNull();
		});
	});

	describe('long stacks keep the crash site (bug 4)', () => {
		it('trimFrames keeps entry context and the innermost frames', () => {
			const frames = Array.from({ length: 150 }, (_, i) => i);
			const trimmed = trimFrames(frames, 100);
			expect(trimmed).toHaveLength(100);
			expect(trimmed.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			expect(trimmed.at(-1)).toBe(149);
			expect(trimmed[10]).toBe(60);
			expect(trimFrames([1, 2, 3], 100)).toEqual([1, 2, 3]);
		});

		it('stores the crashing frame of a 150-frame stack', async () => {
			const frames = Array.from({ length: 150 }, (_, i) => ({
				function: i === 149 ? 'crashSite' : `caller${i}`,
				filename: 'App.swift',
				lineno: i + 1,
				in_app: true,
			}));
			const event = errorEvent({
				exception: { values: [{ type: 'DeepStack', value: 'deep', stacktrace: { frames } }] },
			});
			const res = await post(
				`/api/${ingestId}/envelope/`,
				project.publicKey,
				envelopeOf([{ header: { type: 'event' }, payload: event }]),
			);
			expect(res.status).toBe(200);

			const latest = await authFetch(
				token,
				`${BASE}/api/projects/${project.slug}/events/latest?limit=1`,
			);
			const body = (await latest.json()) as {
				events: Array<{
					exception?: { values: Array<{ stacktrace: { frames: Array<{ function: string }> } }> };
				}>;
			};
			const stored = body.events[0].exception!.values[0].stacktrace.frames;
			expect(stored).toHaveLength(100);
			expect(stored.at(-1)!.function).toBe('crashSite');
		});
	});
});
