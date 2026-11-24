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

- O app protege **todo** o domínio: painel, cadastro/login, APIs do painel e `/api/0`. Login pelo Access (PIN por e-mail), sessão de 7 dias.
- Públicos por override (os SDKs não fazem login; já exigem a chave do DSN): `/api/*/envelope`, `/api/*/envelope/`, `/api/*/store`, `/api/*/store/`, `/api/health`.
- `workers.dev` e preview URLs desligados: não existe caminho até o Worker sem passar pelo Access.
- Ferramentas de CI que usarem a API do painel (ex.: upload de source maps/dSYM no futuro) vão precisar de um **Service Token** do Access.

## Validação feita em 24/11/2026

| Requisição | Resultado |
|---|---|
| `/`, `/register`, `/api/projects`, `/api/auth/register`, `/api/0/projects/` | 302 → login do Access |
| `/api/health` | 200 |
| `POST /api/1/envelope/` e `/store/` com chave falsa | 401 `invalid_auth` (chega ao Sentinel) |
| `OPTIONS /api/1/envelope/` (CORS do SDK de navegador) | 204 |
| `sentinel-lab.<conta>.workers.dev` | 404 (desligado) |
