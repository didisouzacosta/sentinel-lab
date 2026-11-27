/**
 * Gate for the first registration, which makes that user the admin.
 *
 * - With `SETUP_TOKEN` set, the first registration must present it.
 * - Without it, a self-hosted install on its own domain or locally keeps the open bootstrap.
 * - Without it on `*.workers.dev` the first registration is refused: that is where a fresh
 *   Deploy to Cloudflare install lives, publicly reachable, and whoever found the address
 *   first would become the admin.
 */
export interface FirstRegistrationInput {
	isFirstUser: boolean;
	/** Hostname the request reached (from the public request URL). */
	host?: string;
	envSetupToken?: string;
	setupToken?: string;
}

export interface Refusal {
	error: 'setup_token_required' | 'setup_token_unset';
	message: string;
}

export function firstRegistrationRefusal(input: FirstRegistrationInput): Refusal | null {
	if (!input.isFirstUser) {
		return null;
	}

	const configured = input.envSetupToken?.trim() ? input.envSetupToken : undefined;

	if (configured) {
		return input.setupToken === configured
			? null
			: {
					error: 'setup_token_required',
					message: 'First registration requires the server setup token',
				};
	}

	const host = input.host?.toLowerCase() ?? '';

	if (host.endsWith('.workers.dev')) {
		return {
			error: 'setup_token_unset',
			message:
				'Set the SETUP_TOKEN secret on this Worker before the first registration (it becomes the admin)',
		};
	}

	return null;
}
