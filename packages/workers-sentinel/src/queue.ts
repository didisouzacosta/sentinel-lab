import { assembleDebugFile } from './lib/dif-assembly';
import { processSymbolicateJob, SYMBOLICATE_RETRY_DELAY_SECONDS } from './symbolication-job';
import type { Env, ProcessJob } from './types';

/**
 * PROCESS_QUEUE consumer: sentry-cli assemblies too large to run inside the
 * assemble request, and events waiting for symbolication. A thrown error
 * retries the message (queue settings in wrangler.jsonc); content problems
 * are recorded as the assembly's `error` state instead of throwing, and a
 * symbolication that keeps failing stores the event unsymbolicated on its
 * last attempt (src/symbolication-job.ts).
 */
export async function handleQueue(
	batch: MessageBatch<ProcessJob>,
	env: Env,
	ctx?: ExecutionContext,
): Promise<void> {
	const waitUntil = (promise: Promise<unknown>) => {
		if (ctx) ctx.waitUntil(promise);
		else promise.catch(() => {});
	};
	for (const message of batch.messages) {
		const job = message.body;
		try {
			if (job?.type === 'dif.assemble') {
				if (!env.DEBUG_FILES) {
					message.ack();
					continue;
				}
				await assembleDebugFile(env, env.DEBUG_FILES, job);
			} else if (job?.type === 'event.symbolicate') {
				await processSymbolicateJob(env, job, message.attempts, waitUntil);
			}
			message.ack();
		} catch (error) {
			console.error(
				'Queue job failed:',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
			message.retry({
				delaySeconds: job?.type === 'event.symbolicate' ? SYMBOLICATE_RETRY_DELAY_SECONDS : 30,
			});
		}
	}
}
