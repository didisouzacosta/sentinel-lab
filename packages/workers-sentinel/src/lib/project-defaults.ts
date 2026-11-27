import type { Env } from '../types';

/**
 * Settings a project starts with, applied right after it is created.
 *
 * Mobile apps ship their DSN (public by design) and their debug ids inside
 * the binary, so anyone can send crashes that cost symbolication work.
 * They start with an hourly event quota instead of none; owners and admins
 * can change it (or set 0 for unlimited) in the project settings.
 * docs/plano-riscos-simbolizacao.md, decision 3.
 */
export const MOBILE_DEFAULT_MAX_EVENTS_PER_HOUR = 5000;

/** Platform ids and Sentry slugs of apps whose crashes get symbolicated. */
const MOBILE_PLATFORMS = new Set([
	'ios',
	'cocoa',
	'apple',
	'apple-ios',
	'android',
	'java-android',
	'react-native',
	'flutter',
]);

export function isMobilePlatform(platform: unknown): boolean {
	return typeof platform === 'string' && MOBILE_PLATFORMS.has(platform.toLowerCase());
}

/** Best effort: a failure here never fails the project creation. */
export async function applyNewProjectDefaults(
	env: Env,
	projectId: string,
	platform: unknown,
): Promise<void> {
	if (!isMobilePlatform(platform)) return;
	try {
		const projectState = env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
		const response = await projectState.fetch(
			new Request('http://internal/config/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ maxEventsPerHour: MOBILE_DEFAULT_MAX_EVENTS_PER_HOUR }),
			}),
		);
		if (!response.ok) console.error(`New project defaults: config answered ${response.status}`);
	} catch (error) {
		console.error(
			'New project defaults failed:',
			error instanceof Error ? error.message.slice(0, 120) : 'unknown',
		);
	}
}
