import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser } from './utils';

/**
 * The DSN in the envelope header is a credential on its own (Sentry accepts
 * it; SDK tunnels and SDK-less senders put it nowhere else). The envelopes
 * below are byte-for-byte what Tem Horário's two SDK-less reporters build:
 * the Workers API (`SentryErrorReporter`, fetch with
 * application/x-sentry-envelope) and the browser (`reportError`,
 * navigator.sendBeacon with a string body → text/plain;charset=UTF-8).
 */
describe('Ingestion: DSN from the envelope header', () => {
	let token: string;
	let project: Awaited<ReturnType<typeof createTestProject>>;
	let other: Awaited<ReturnType<typeof createTestProject>>;

	beforeAll(async () => {
		const user = await createTestUser({
			email: `envelope-dsn-${Date.now()}@example.com`,
			password: 'testpassword123',
			name: 'Envelope DSN User',
		});
		token = user.token!;
		project = await createTestProject(token, { name: 'Envelope DSN Project' });
		other = await createTestProject(token, { name: 'Envelope DSN Other' });
	});

	const dsnOf = (p: { id: string; publicKey: string }) =>
		`https://${p.publicKey}@sentinel.example.com/${p.id}`;

	const newId = () => crypto.randomUUID().replace(/-/g, '');

	/** Tem Horário API worker (packages/adapters/observability/observability.ts). */
	function apiEnvelope(dsn: string, eventId = newId()): string {
		const err = new TypeError("Cannot read properties of undefined (reading 'id')");
		const frames = (err.stack ?? '')
			.split('\n')
			.slice(1, 20)
			.map((line) => ({ function: line.trim() }))
			.reverse();
		const event = {
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: 'javascript',
			environment: 'staging',
			release: 'tenho-horario@0.21.0+13819d1',
			tags: { route: '/api/agenda', method: 'GET' },
			extra: { requestId: 'req-123' },
			level: 'error',
			exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames } }] },
		};
		return (
			`${JSON.stringify({ event_id: eventId, dsn, sent_at: new Date().toISOString() })}\n` +
			`${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
		);
	}

	/** Tem Horário browser (apps/web/src/lib/observability.ts). */
	function browserEnvelope(dsn: string, eventId = newId()): string {
		const event = {
			event_id: eventId,
			timestamp: Date.now() / 1000,
			platform: 'javascript',
			environment: 'production',
			release: 'tenho-horario@0.21.0',
			tags: { route: undefined, method: undefined, page: 'app' },
			exception: { values: [{ type: 'Error', value: 'browser envelope-dsn probe' }] },
		};
		return `${JSON.stringify({ event_id: eventId, dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
	}

	function post(
		projectId: string,
		body: BodyInit,
		headers: Record<string, string> = { 'Content-Type': 'application/x-sentry-envelope' },
	) {
		return SELF.fetch(`http://localhost/api/${projectId}/envelope/`, {
			method: 'POST',
			headers,
			body,
		});
	}

	async function expectStored(eventId: string) {
		const stored = await authFetch(
			token,
			`http://localhost/api/projects/${project.slug}/events/${eventId}`,
		);
		expect(stored.status).toBe(200);
		const data = (await stored.json()) as { event: { event_id: string } };
		expect(data.event.event_id).toBe(eventId);
	}

	it('ingests the Workers API envelope with no other credential', async () => {
		const eventId = newId();
		const response = await post(project.id, apiEnvelope(dsnOf(project), eventId));
		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(eventId);
		await expectStored(eventId);
	});

	it('ingests the sendBeacon envelope (text/plain, no other credential)', async () => {
		const eventId = newId();
		const response = await post(project.id, browserEnvelope(dsnOf(project), eventId), {
			'Content-Type': 'text/plain;charset=UTF-8',
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(eventId);
		await expectStored(eventId);
	});

	it('reads the header DSN through gzip', async () => {
		const eventId = newId();
		const compressed = await new Response(
			new Blob([apiEnvelope(dsnOf(project), eventId)])
				.stream()
				.pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer();
		const response = await post(project.id, compressed, {
			'Content-Type': 'application/x-sentry-envelope',
			'Content-Encoding': 'gzip',
		});
		expect(response.status).toBe(200);
		await expectStored(eventId);
	});

	it('reads the header DSN when the first line arrives split across chunks', async () => {
		const eventId = newId();
		const bytes = new TextEncoder().encode(apiEnvelope(dsnOf(project), eventId));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		});
		const response = await post(project.id, body);
		expect(response.status).toBe(200);
		await expectStored(eventId);
	});

	it('accepts the numeric ingest id in both the URL and the header DSN', async () => {
		const ingestId = project.dsn.split('/').pop()!;
		const response = await post(
			ingestId,
			apiEnvelope(`https://${project.publicKey}@sentinel.example.com/${ingestId}`),
		);
		expect(response.status).toBe(200);
	});

	it('rejects a header DSN whose project differs from the URL', async () => {
		// key and URL agree (project), but the DSN names another project
		const response = await post(
			project.id,
			apiEnvelope(`https://${project.publicKey}@sentinel.example.com/${other.id}`),
		);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('project_mismatch');
	});

	it("rejects another project's DSN sent to this project's URL", async () => {
		const response = await post(project.id, apiEnvelope(dsnOf(other)));
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('project_mismatch');
	});

	it('rejects an unknown key in the header DSN', async () => {
		const response = await post(
			project.id,
			apiEnvelope(`https://not-a-key@sentinel.example.com/${project.id}`),
		);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toBe('invalid_auth');
	});

	it('answers missing_auth when the header has no usable DSN', async () => {
		for (const header of [
			{ event_id: newId() },
			{ event_id: newId(), dsn: '' },
			{ event_id: newId(), dsn: 'not a url' },
			{ event_id: newId(), dsn: `https://sentinel.example.com/${project.id}` },
		]) {
			const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n{"message":"x"}\n`;
			const response = await post(project.id, body);
			expect(response.status).toBe(401);
			expect(((await response.json()) as { error: string }).error).toBe('missing_auth');
		}
	});

	it('answers missing_auth when the first line is not a JSON object or never ends', async () => {
		const huge = `{"pad":"${'a'.repeat(70 * 1024)}","dsn":"${dsnOf(project)}"}\n`;
		for (const body of ['not json\n{"type":"event"}\n{}\n', '[1,2]\n', huge]) {
			const response = await post(project.id, body);
			expect(response.status).toBe(401);
		}
	});

	it('bounds the header line itself, not the chunks it arrived in', async () => {
		// One chunk holding a >64 KiB first line plus its newline: still refused
		const huge = new TextEncoder().encode(
			`{"pad":"${'a'.repeat(70 * 1024)}","dsn":"${dsnOf(project)}"}\n{"type":"event"}\n{}\n`,
		);
		const oneChunk = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(huge);
				controller.close();
			},
		});
		const response = await post(project.id, oneChunk);
		expect(response.status).toBe(401);
	});

	it('prefers an explicit credential over the header DSN', async () => {
		// X-Sentry-Auth names the project; the header DSN is never consulted
		const response = await post(project.id, apiEnvelope(dsnOf(other)), {
			'Content-Type': 'application/x-sentry-envelope',
			'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${project.publicKey}`,
		});
		expect(response.status).toBe(200);
	});
});
