import { createAttachmentStore } from './lib/attachment-store';
import { eventDebugImages } from './lib/debug-files';
import { setEventTag, symbolicationKinds } from './lib/symbolicate';
import { buildWebhookPayload, sendWebhook } from './lib/webhook';
import { SymbolicatorRejected, symbolicateEvent } from './symbolicator';
import type { Env, Project, SentryEvent } from './types';

/**
 * Events waiting for symbolication. Ingestion parks the event (plus its
 * attachment metadata) in the DEBUG_FILES bucket and enqueues a pointer —
 * queue messages are capped at 128 KB and Symbolicator may need a cold
 * start, which the SDK must not wait for. The consumer symbolicates and
 * hands the event to ProjectState exactly like ingestion would have.
 *
 * Parked objects live under `staging/`, whose 1-day lifecycle rule cleans
 * up anything a lost message leaves behind. Attachment blobs are already in
 * ATTACHMENTS; the job finishes well inside the orphan GC's 1-hour grace.
 */

export interface SymbolicateJob {
	type: 'event.symbolicate';
	projectId: string;
	key: string;
}

interface AttachmentMeta {
	filename: string;
	contentType: string;
	size: number;
	r2Key: string;
}

interface ParkedEvent {
	event: SentryEvent;
	attachments: AttachmentMeta[];
	uploadedKeys: string[];
	project: Pick<Project, 'id' | 'name' | 'slug' | 'webhookUrl'>;
	parkedAt: string;
}

/** Retry policy (wrangler.jsonc `max_retries` is the ceiling). */
export const SYMBOLICATE_RETRY_DELAY_SECONDS = 60;
/**
 * From this delivery on, a failing symbolication no longer retries: the
 * event is stored as it came, tagged `symbolication:failed`. ~4 minutes of
 * attempts, well under the attachment GC's grace period.
 */
export const SYMBOLICATE_LAST_ATTEMPT = 4;

/**
 * Longest an event waits for symbolication. Past it (a backlog after a
 * crash storm, with the consumer's max_concurrency), it is stored as
 * received, tagged `symbolication: skipped` / `symbolication_reason:
 * backlog`, so no event sits in the queue for long and the queue drains
 * by itself. Well under the attachment GC's 1-hour grace.
 */
export const SYMBOLICATE_MAX_WAIT_MS = 10 * 60 * 1000;

export function symbolicationEnabled(env: Env): boolean {
	return Boolean(
		env.SYMBOLICATION !== 'off' && env.SYMBOLICATOR && env.PROCESS_QUEUE && env.DEBUG_FILES,
	);
}

type ProjectStub = { fetch(request: Request): Promise<Response> };

/**
 * Whether an event should wait for symbolication: it carries debug images
 * Symbolicator can use, at least one of them has a stored debug file, and
 * the project would accept the event now (quota, purge). Everything else
 * takes the direct path, which answers the SDK as before.
 */
export type Admission =
	| { park: true }
	/** `budget` / `disabled`: the project's symbolication budget said no; the event is tagged `skipped`. */
	| { park: false; reason?: 'budget' | 'disabled' };

export async function shouldSymbolicate(
	env: Env,
	projectState: ProjectStub,
	event: SentryEvent,
): Promise<Admission> {
	if (!symbolicationEnabled(env)) return { park: false };
	const kinds = symbolicationKinds(event);
	if (!kinds.native && !kinds.jvm) return { park: false };
	const debugIds = eventDebugImages(event).map((image) => image.debugId);
	if (debugIds.length === 0) return { park: false };
	try {
		const response = await projectState.fetch(
			new Request('http://internal/symbolication/admit', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ debugIds }),
			}),
		);
		if (!response.ok) return { park: false };
		const { admit, reason } = (await response.json()) as { admit?: boolean; reason?: string };
		if (admit === true) return { park: true };
		return reason === 'budget' || reason === 'disabled' ? { park: false, reason } : { park: false };
	} catch {
		return { park: false };
	}
}

/** Park an event and enqueue its symbolication. Returns the event id answered to the SDK. */
export async function parkEvent(
	env: Env,
	project: Project,
	event: SentryEvent,
	attachments: AttachmentMeta[],
	uploadedKeys: string[],
): Promise<string> {
	const bucket = env.DEBUG_FILES as R2Bucket;
	const queue = env.PROCESS_QUEUE as Queue;
	if (
		typeof event.event_id !== 'string' ||
		!/^[0-9a-f]{32}$/i.test(event.event_id.replace(/-/g, ''))
	) {
		event.event_id = crypto.randomUUID().replace(/-/g, '');
	}
	const key = `staging/${project.id}/event-${crypto.randomUUID()}`;
	const parked: ParkedEvent = {
		event,
		attachments,
		uploadedKeys,
		project: {
			id: project.id,
			name: project.name,
			slug: project.slug,
			webhookUrl: project.webhookUrl ?? null,
		},
		parkedAt: new Date().toISOString(),
	};
	await bucket.put(key, JSON.stringify(parked), {
		httpMetadata: { contentType: 'application/json' },
	});
	const job: SymbolicateJob = { type: 'event.symbolicate', projectId: project.id, key };
	await queue.send(job);
	return event.event_id;
}

/**
 * Queue consumer for one parked event. Throws to have the message retried
 * (Symbolicator unavailable, ProjectState hiccup); never throws on the last
 * attempt for symbolication errors, so the event is not lost.
 */
export async function processSymbolicateJob(
	env: Env,
	job: SymbolicateJob,
	attempt: number,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
	const bucket = env.DEBUG_FILES;
	if (!bucket) return;
	const object = await bucket.get(job.key);
	if (!object) return; // already delivered, or swept by a project purge
	const parked = (await object.json()) as ParkedEvent;
	const store = createAttachmentStore(env, null);
	const drop = async () => {
		await store.deleteKeys(parked.uploadedKeys).catch(() => {});
		await bucket.delete(job.key);
	};

	// A project deleted while its event waited must not get it back (nor
	// cost container time): the purge may already have swept its state.
	if (!(await projectExists(env, parked.project.id))) {
		await drop();
		return;
	}

	// The event exactly as received, for the fallbacks below.
	const received = JSON.stringify(parked.event);
	const event = parked.event as unknown as Record<string, unknown>;
	let symbolicated = false;
	const waitedMs = Date.now() - Date.parse(parked.parkedAt);
	if (!(waitedMs <= SYMBOLICATE_MAX_WAIT_MS)) {
		// Too late to be worth it (or an unreadable timestamp): store as is.
		setEventTag(event, 'symbolication', 'skipped');
		setEventTag(event, 'symbolication_reason', 'backlog');
		console.warn(
			JSON.stringify({
				event: 'symbolication.backlog_skip',
				projectId: parked.project.id,
				waitedSeconds: Number.isFinite(waitedMs) ? Math.round(waitedMs / 1000) : null,
			}),
		);
	} else {
		try {
			const outcome = await symbolicateEvent(env, parked.project.id, event);
			symbolicated = outcome.frames > 0;
			setEventTag(event, 'symbolication', symbolicated ? 'done' : 'missing');
		} catch (error) {
			// Input Symbolicator rejects never gets better with retries.
			if (!(error instanceof SymbolicatorRejected) && attempt < SYMBOLICATE_LAST_ATTEMPT) {
				throw error;
			}
			console.error(
				'Symbolication failed, storing the event as received:',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
			setEventTag(event, 'symbolication', 'failed');
		}
	}

	let response = await ingest(env, parked, event);
	if (symbolicated && !response.ok && !(await isFinalRejection(response))) {
		// The symbolicated event is bigger (raw_stacktrace, inlined frames)
		// and may not fit where the original does: store the original.
		const original = JSON.parse(received) as Record<string, unknown>;
		setEventTag(original, 'symbolication', 'failed');
		response = await ingest(env, parked, original);
	}

	if (await isFinalRejection(response)) {
		// Over quota or project being purged: the SDK already got its 200,
		// so the event is dropped like any other rejected ingest.
		await drop();
		return;
	}
	if (!response.ok) {
		throw new Error(`ingest answered ${response.status}`);
	}

	const result = (await response.json()) as {
		eventId?: string;
		issueId?: string;
		isNewIssue?: boolean;
		title?: string;
		level?: string;
		culprit?: string | null;
		storedR2Keys?: string[];
	};
	const committed = new Set(Array.isArray(result.storedR2Keys) ? result.storedR2Keys : []);
	const orphans = parked.uploadedKeys.filter((key) => !committed.has(key));
	if (orphans.length > 0) await store.deleteKeys(orphans).catch(() => {});

	if (parked.project.webhookUrl && result.isNewIssue && result.title && result.issueId) {
		const payload = buildWebhookPayload(
			{ id: parked.project.id, name: parked.project.name, slug: parked.project.slug },
			{
				id: result.issueId,
				title: result.title,
				level: result.level || 'error',
				culprit: result.culprit || null,
			},
		);
		waitUntil(sendWebhook(parked.project.webhookUrl, payload));
	}
	await bucket.delete(job.key);
}

function ingest(env: Env, parked: ParkedEvent, event: Record<string, unknown>): Promise<Response> {
	const projectState = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(parked.project.id));
	return projectState.fetch(
		new Request('http://internal/ingest-with-attachments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event,
				attachments: parked.attachments,
				projectId: parked.project.id,
			}),
		}),
	);
}

/** 429 (quota) or 503 purge_pending: the event is dropped, not retried. */
async function isFinalRejection(response: Response): Promise<boolean> {
	if (response.status === 429) return true;
	if (response.status !== 503) return false;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as { error?: string } | null;
	return body?.error === 'purge_pending';
}

async function projectExists(env: Env, projectId: string): Promise<boolean> {
	const authState = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
	const response = await authState.fetch(
		new Request('http://internal/project-exists', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId }),
		}),
	);
	if (!response.ok) throw new Error(`project lookup answered ${response.status}`);
	const { exists } = (await response.json()) as { exists?: boolean };
	return exists === true;
}
