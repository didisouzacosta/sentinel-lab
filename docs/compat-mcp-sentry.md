# MCP do Sentry contra o `/api/0` do Sentinel

Teste feito em 25/11/2026 com `@sentry/mcp-server` **0.51.0** (stdio), apontado para o worker local
(`SENTRY_URL=http://127.0.0.1:8787`, token pessoal `wst_` do usuário demo), projeto `cli-feedback`.
Cada ferramenta foi chamada por um cliente MCP mínimo e as rotas foram conferidas no log do worker.

## Como configurar (a versão 0.51 mudou a linha de comando)

`--host` e `--access-token` foram descontinuados. O servidor agora roda com o subcomando `mcp` e lê
o endereço e o token de variáveis de ambiente:

```bash
claude mcp add sentinel \
  -e SENTRY_URL=https://sentinel.example.com \
  -e SENTRY_AUTH_TOKEN=wst_… \
  -- npx -y @sentry/mcp-server@0.51.0 mcp
```

A versão fica fixa porque a compatibilidade foi verificada só nela; o `@latest` já mudou a interface uma vez.
Sem chave de LLM (`ANTHROPIC_API_KEY` etc.) a busca em linguagem natural fica desligada, mas a busca
com sintaxe direta (`is:unresolved`) continua funcionando.

## Resultado por ferramenta

| Ferramenta | Resultado | Rota chamada / motivo |
|---|---|---|
| `find_organizations` | ✅ funciona | `GET /organizations/` |
| `find_projects` | ✅ funciona | `GET /organizations/{org}/projects/` |
| `search_issues` (sem projeto) | ✅ funciona | `GET /organizations/{org}/issues/?query=is:…` |
| `update_issue` (com `issueUrl`) | ✅ funciona | `GET` + `PUT /organizations/{org}/issues/{id}/` |
| `search_issue_events` | ✅ funciona | `GET /organizations/{org}/issues/{id}/events/` |
| `get_event_attachment` | ✅ funciona | `GET /projects/{org}/{project}/events/{event}/attachments/` |
| Qualquer ferramenta com `issueId` | ❌ 404 | o MCP converte o id para maiúsculas (trata como *short ID* `PROJ-123`) e o Sentinel só acha o UUID minúsculo. Passando `issueUrl` o caso é preservado |
| `get_issue_details`, `get_sentry_resource` | ❌ erro de validação | o evento traz `release` como texto; o MCP espera objeto (`{version, …}`) ou `null` |
| `add_issue_note` | ❌ 404 | o MCP usa `…/issues/{id}/notes/`; o Sentinel só tem `…/comments/` |
| `get_issue_activity` | ❌ 404 | `…/issues/{id}/activities/` não existe |
| `search_issues` com projeto, `search_errors` | ❌ 404 | `GET /projects/{org}/{project}/` (detalhe do projeto) não existe; `search_errors` usa ainda o Discover (`/organizations/{org}/events/`) |
| `whoami` | ❌ 404 | `GET /auth/` e `GET /users/me/` não existem |
| `get_event_stacktrace`, `get_issue_breadcrumbs` | ❌ 404 | mesmo problema do `issueId` em maiúsculas |
| `find_releases`, `find_teams`, `find_dsns` | ❌ 404 | `releases/`, `teams/`, `keys/` não existem no `/api/0` |
| Monitores, alertas, traces, replays, profiles, dashboards | — fora do escopo | o Sentinel não tem esses recursos |

## O que destravaria o uso no dia a dia (lado do worker)

1. Aceitar o id da issue sem diferenciar maiúsculas/minúsculas em todas as rotas `/api/0/…/issues/{id}/…`.
2. Serializar `release` do evento como objeto (`{"version": "…"}`) ou `null`.
3. Apelidos `…/issues/{id}/notes/` → `comments/` e `…/issues/{id}/activities/` (lista a partir do histórico que já existe).
4. `GET /api/0/projects/{org}/{project}/` (detalhe do projeto, mesmo serializer da lista).
5. `GET /api/0/auth/` (usuário do token) para o `whoami`.

Com 1–4 passam a funcionar detalhes da issue, stack trace, breadcrumbs, notas, atividade e busca por projeto,
que cobrem o fluxo de triagem que a página **Connect** promete. Releases, times e chaves podem vir depois.
