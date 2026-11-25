# Recursos Cloudflare do Sentinel Lab

Conta: a conta Cloudflare pessoal (a mesma do `npx wrangler whoami`).
Todo recurso criado por este projeto começa com **`sentinel-lab`** / **`Sentinel Lab ·`**. Nada fora desta lista existe por causa dele.
`lab/teardown.sh` apaga tudo o que está marcado como "criado".

| Recurso | Nome | Tipo | Status | Criado por |
|---|---|---|---|---|
| Worker (API + painel) | `sentinel-lab` | Workers | criado em 24/11/2026 | `lab/setup.sh` (`wrangler deploy`) |
| Domínio | `sentinel.adrianosouzacosta.com.br` | Workers Custom Domain (DNS + certificado gerenciados) | criado | `wrangler deploy`; sai junto com o Worker |
| Durable Objects `AuthState`, `ProjectState` | dentro do Worker `sentinel-lab` | Durable Objects (SQLite) | criado | apagados junto com o Worker |
| Bucket de anexos | `sentinel-lab-attachments` | R2 | criado | `lab/setup.sh` |
| App do Access | `Sentinel Lab · painel` | Zero Trust Access (self-hosted) | criado | `lab/access.mjs apply` |
| Política do Access | `Sentinel Lab · administradores` (allow por e-mail) | Zero Trust Access (reutilizável) | criado | `lab/access.mjs apply` |
| Fila de processamento | `sentinel-lab-process` | Queues | futuro (simbolização) | — |
| Bucket de debug files (dSYM, mapping, source maps) | `sentinel-lab-debug-files` | R2 | futuro (simbolização) | — |
| Simbolizador | `sentinel-lab-symbolicator` | Containers | futuro (simbolização) | — |

## Proteção (Access)

- O app protege o domínio: painel, cadastro/login e APIs do painel. Login pelo Access (PIN por e-mail), sessão de 7 dias.
- Públicos por override (clientes que não fazem login no Access e que o Sentinel já autentica):
  - ingestão dos SDKs, que exige a chave do DSN: `/api/*/envelope`, `/api/*/envelope/`, `/api/*/store`, `/api/*/store/`, e `/api/health`;
  - `/api/0/*` (desde 25/11/2026), a API no formato do Sentry usada pelo MCP do Sentry e por agentes: exige token `wst_` ou sessão, e sem credencial responde 401.
  - `/mcp` (aplicado em 25/11/2026), o MCP do próprio Sentinel: mesma autenticação, 401 sem credencial. As ferramentas chamam as rotas do painel por dentro do Worker, sem passar de novo pelo Access.
- `workers.dev` e preview URLs desligados: não existe caminho até o Worker sem passar pelo Access.
- Ferramentas de CI que usarem a API do painel (ex.: upload de source maps/dSYM no futuro) vão precisar de um **Service Token** do Access.

## Validação feita em 24/11/2026

| Requisição | Resultado |
|---|---|
| `/`, `/register`, `/api/projects`, `/api/auth/register` | 302 → login do Access |
| `/api/0/organizations/` sem token ou com token inválido (25/11/2026) | 401 do Sentinel (`{"detail": …}`) |
| Deploy das fases 0–3 + Export (25/11/2026, versão `651bc15b`): envelope com o DSN só no cabeçalho e chave falsa | 401 `invalid_auth` (antes: `missing_auth`) — a chave do cabeçalho é lida |
| `POST /mcp` sem token, antes do `access.mjs apply` (25/11/2026) | 302 → login do Access (esperado até aplicar o override) |
| `POST /mcp` sem token / com token inválido, depois do `apply` (25/11/2026) | 401 do Sentinel; `/`, `/api/projects` seguem em 302 → Access |
| Novo deploy em 25/11/2026 (versão `2ac7f7fe`, commit `a176892`, com o guia iOS do SentinelKit) | health 200, `POST /mcp` 401, painel 302, ingestão sem chave 401 |
| `/api/health` | 200 |
| `POST /api/1/envelope/` e `/store/` com chave falsa | 401 `invalid_auth` (chega ao Sentinel) |
| `OPTIONS /api/1/envelope/` (CORS do SDK de navegador) | 204 |
| `sentinel-lab.<conta>.workers.dev` | 404 (desligado) |
