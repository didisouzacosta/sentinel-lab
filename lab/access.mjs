#!/usr/bin/env node
// Proteção do Sentinel Lab pelo Cloudflare Access (Zero Trust).
//
//   node lab/access.mjs apply    cria/atualiza a política e o app (idempotente)
//   node lab/access.mjs delete   remove o app e a política do Sentinel Lab
//   node lab/access.mjs show     mostra o que existe hoje
//
// Requer CLOUDFLARE_API_TOKEN (permissão "Access: Apps and Policies Edit") e
// CLOUDFLARE_ACCOUNT_ID. SENTINEL_ADMIN_EMAILS (vírgulas) define quem entra
// no painel.
//
// Desenho: um único app protege o domínio inteiro (painel e APIs do painel).
// Ficam públicos, por override, só os caminhos de clientes que não fazem login
// no Access e que o próprio Sentinel já autentica:
// - ingestão dos SDKs (exige a chave do DSN);
// - /api/0, a API no formato do Sentry usada pelo MCP do Sentry e por agentes
//   (exige token de API `wst_` ou sessão; sem credencial responde 401);
// - /mcp, o MCP do próprio Sentinel (mesma autenticação: token `wst_` ou
//   sessão; sem credencial responde 401). As ferramentas chamam as rotas do
//   painel por dentro do Worker, então o Access do painel continua valendo
//   para quem acessa de fora.

const HOST = 'sentinel.adrianosouzacosta.com.br';
const APP_NAME = 'Sentinel Lab · painel';
const POLICY_NAME = 'Sentinel Lab · administradores';
export const PUBLIC_PATHS = [
	'/api/*/envelope',
	'/api/*/envelope/',
	'/api/*/store',
	'/api/*/store/',
	'/api/health',
	'/api/0/*',
	'/mcp',
];

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const admins = (process.env.SENTINEL_ADMIN_EMAILS ?? '')
	.split(',')
	.map((e) => e.trim())
	.filter(Boolean);

async function cf(method, path, body) {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json();
	if (!data.success) throw new Error(`${method} ${path}: ${JSON.stringify(data.errors)}`);
	return data.result;
}

const findByName = async (path, name) =>
	(await cf('GET', `${path}?per_page=100`)).find((x) => x.name === name);

async function apply() {
	if (admins.length === 0) throw new Error('Defina SENTINEL_ADMIN_EMAILS');
	const policyBody = {
		name: POLICY_NAME,
		decision: 'allow',
		include: admins.map((email) => ({ email: { email } })),
	};
	// The reusable-policy listing can come back without the policy — a token
	// with app permissions but none on reusable policies sees it only through
	// the app (2026-11-25: `show` printed "policy": null). Fall back to the
	// policy the app already uses, so apply never creates a same-named
	// duplicate.
	const existingPolicy =
		(await findByName('/access/policies', POLICY_NAME)) ??
		(await findByName('/access/apps', APP_NAME))?.policies?.find((p) => p.name === POLICY_NAME);
	// Rewrite the policy only when the admin list changes: adding a public
	// path (e.g. /mcp) then needs app permissions alone.
	const emailsOf = (p) =>
		(p?.include ?? [])
			.map((rule) => rule.email?.email)
			.filter(Boolean)
			.sort()
			.join(',');
	const unchanged = existingPolicy && emailsOf(existingPolicy) === [...admins].sort().join(',');
	const policy = unchanged
		? existingPolicy
		: existingPolicy
			? await cf('PUT', `/access/policies/${existingPolicy.id}`, policyBody)
			: await cf('POST', '/access/policies', policyBody);
	if (unchanged) console.log(`Política "${POLICY_NAME}" sem mudança (mesmos e-mails); só o app é atualizado.`);

	const appBody = {
		name: APP_NAME,
		type: 'self_hosted',
		domain: HOST,
		destinations: [
			{
				type: 'public',
				uri: HOST,
				overrides: PUBLIC_PATHS.map((path_pattern) => ({ path_pattern, behavior: 'public' })),
			},
		],
		session_duration: '168h',
		app_launcher_visible: true,
		policies: [{ id: policy.id, precedence: 1 }],
	};
	const existingApp = await findByName('/access/apps', APP_NAME);
	const app = existingApp
		? await cf('PUT', `/access/apps/${existingApp.id}`, appBody)
		: await cf('POST', '/access/apps', appBody);
	console.log(`Access ok: app "${app.name}" (${app.id}) com a política "${policy.name}".`);
}

async function remove() {
	const app = await findByName('/access/apps', APP_NAME);
	if (app) {
		await cf('DELETE', `/access/apps/${app.id}`);
		console.log(`App "${APP_NAME}" removido.`);
	}
	const policy = await findByName('/access/policies', POLICY_NAME);
	if (policy) {
		await cf('DELETE', `/access/policies/${policy.id}`);
		console.log(`Política "${POLICY_NAME}" removida.`);
	}
	if (!app && !policy) console.log('Nada do Sentinel Lab no Access.');
}

async function show() {
	const app = await findByName('/access/apps', APP_NAME);
	const policy = await findByName('/access/policies', POLICY_NAME);
	console.log(JSON.stringify({ app: app ?? null, policy: policy ?? null }, null, 2));
}

const commands = { apply, delete: remove, show };
const command = commands[process.argv[2]];
if (!command || !token || !account) {
	console.error(
		'Uso: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… [SENTINEL_ADMIN_EMAILS=…] node lab/access.mjs apply|delete|show',
	);
	process.exit(1);
}
await command();
