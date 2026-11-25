import { assembleDebugFile } from './lib/dif-assembly';
import type { Env, ProcessJob } from './types';

/**
 * PROCESS_QUEUE consumer. Today: sentry-cli assemblies too large to run
 * inside the assemble request. A thrown error retries the message (queue
 * settings in wrangler.jsonc); content problems are recorded as the
 * assembly's `error` state instead of throwing.
 */
export async function handleQueue(batch: MessageBatch<ProcessJob>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const job = message.body;
		try {
			if (job?.type === 'dif.assemble') {
				if (!env.DEBUG_FILES) {
					message.ack();
					continue;
				}
				await assembleDebugFile(env, env.DEBUG_FILES, job);
			}
			message.ack();
		} catch (error) {
			console.error(
				'Queue job failed:',
				error instanceof Error ? error.message.slice(0, 120) : 'unknown',
			);
			message.retry({ delaySeconds: 30 });
		}
	}
}
