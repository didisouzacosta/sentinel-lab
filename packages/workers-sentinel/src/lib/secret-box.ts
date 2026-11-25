/**
 * Encryption at rest for integration credentials (Kaneo API key, webhook
 * signing secret).
 *
 * AES-256-GCM with a key derived by HKDF-SHA256 from the Worker secret
 * `INTEGRATIONS_KEY`. The project id is bound twice: as the HKDF `info`
 * (one derived key per project) and as the GCM additional data, so a
 * ciphertext copied into another project's storage does not decrypt.
 *
 * Wire format: `v1.<base64url iv>.<base64url ciphertext+tag>`.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SecretBoxError extends Error {}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function deriveKey(masterSecret: string, projectId: string): Promise<CryptoKey> {
	if (!masterSecret || masterSecret.length < 32) {
		throw new SecretBoxError('INTEGRATIONS_KEY must be at least 32 characters');
	}
	const base = await crypto.subtle.importKey('raw', encoder.encode(masterSecret), 'HKDF', false, [
		'deriveKey',
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode('sentinel-integrations-v1'),
			info: encoder.encode(`project:${projectId}`),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function sealSecret(
	masterSecret: string,
	projectId: string,
	plaintext: string,
): Promise<string> {
	const key = await deriveKey(masterSecret, projectId);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(projectId) },
		key,
		encoder.encode(plaintext),
	);
	return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openSecret(
	masterSecret: string,
	projectId: string,
	sealed: string,
): Promise<string> {
	const parts = sealed.split('.');
	if (parts.length !== 3 || parts[0] !== VERSION) {
		throw new SecretBoxError('unsupported secret format');
	}
	const key = await deriveKey(masterSecret, projectId);
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: fromBase64Url(parts[1]),
				additionalData: encoder.encode(projectId),
			},
			key,
			fromBase64Url(parts[2]),
		);
		return decoder.decode(plaintext);
	} catch {
		throw new SecretBoxError('secret could not be decrypted');
	}
}

/** `abcd…wxyz` for display; short values are fully hidden. */
export function maskSecret(value: string | null | undefined): string | null {
	if (!value) return null;
	if (value.length <= 12) return '••••';
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Random secret for signing webhooks (hex, 32 bytes). */
export function randomSecret(bytes = 32): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
}
