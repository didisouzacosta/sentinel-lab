import type { Context } from 'hono';
import type { ApiTokenScope, AuthContext } from '../types';

/**
 * API token scopes, from least to most powerful. Each scope implies the
 * ones before it, so a stored scope list is always "closed downward":
 *
 * - `read`     — every GET on the protected surface (`/api/projects/*`,
 *               `/api/0/*`): projects, DSNs, issues, events, attachments.
 * - `write`    — any other method there: triage, notes, project settings.
 * - `projects` — project lifecycle: create, rotate the DSN key, delete.
 *               Minted only by an admin signed in with a passkey (the same
 *               bar as the admin area) and honored only while the owner is
 *               still an admin.
 *
 * Sessions are not scoped (they carry the user's full rights); scopes only
 * narrow what a `wst_` token may do. Tokens minted before scopes existed
 * are `read` + `write` — exactly what every token could do then.
 */
export const API_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read', 'write', 'projects'];

export const DEFAULT_API_TOKEN_SCOPES: readonly ApiTokenScope[] = ['read', 'write'];

function closeDownward(scopes: Iterable<ApiTokenScope>): ApiTokenScope[] {
	const top = Math.max(-1, ...Array.from(scopes, (s) => API_TOKEN_SCOPES.indexOf(s)));
	return API_TOKEN_SCOPES.slice(0, top + 1);
}

/** Validates a client-supplied scope list (undefined → the default). */
export function normalizeScopes(
	input: unknown,
): { ok: true; scopes: ApiTokenScope[] } | { ok: false; message: string } {
	if (input === undefined || input === null) {
		return { ok: true, scopes: [...DEFAULT_API_TOKEN_SCOPES] };
	}
	if (!Array.isArray(input) || input.length === 0) {
		return { ok: false, message: 'scopes must be a non-empty array' };
	}
	for (const scope of input) {
		if (typeof scope !== 'string' || !API_TOKEN_SCOPES.includes(scope as ApiTokenScope)) {
			return {
				ok: false,
				message: `Unknown scope ${JSON.stringify(scope)}; valid scopes: ${API_TOKEN_SCOPES.join(', ')}`,
			};
		}
	}
	return { ok: true, scopes: closeDownward(input as ApiTokenScope[]) };
}

/** Reads the stored comma list; unknown entries are ignored. */
export function parseStoredScopes(stored: unknown): ApiTokenScope[] {
	if (typeof stored !== 'string' || stored.length === 0) return [...DEFAULT_API_TOKEN_SCOPES];
	const known = stored
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is ApiTokenScope => API_TOKEN_SCOPES.includes(s as ApiTokenScope));
	return known.length === 0 ? ['read'] : closeDownward(known);
}

/** True for sessions; for API tokens, whether the token carries `scope`. */
export function hasScope(auth: AuthContext, scope: ApiTokenScope): boolean {
	return !auth.apiToken || auth.apiToken.scopes.includes(scope);
}

/** 403 `insufficient_scope` when an API token lacks `scope`; null otherwise. */
export function requireScope(c: Context, auth: AuthContext, scope: ApiTokenScope): Response | null {
	if (hasScope(auth, scope)) return null;
	return c.json(
		{
			error: 'insufficient_scope',
			message: `This API token needs the "${scope}" scope`,
			required: scope,
		},
		403,
	);
}

/** Audit attribution for an action taken with an API token. */
export function auditVia(auth: AuthContext): { via: 'api_token'; tokenPrefix: string } | undefined {
	return auth.apiToken ? { via: 'api_token', tokenPrefix: auth.apiToken.prefix } : undefined;
}
