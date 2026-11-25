# Plano: envio e simbolização de dSYM (iOS) e mapping ProGuard/R8 (Android)

## Contexto

O objetivo do lab (lab/README.md, "Próximos passos" 1–4; lab/RELATORIO.md) é simbolizar crashes nativos. Hoje:

- Os eventos já guardam o que é preciso: `debug_meta.images` (UUID `macho` do dSYM ou `proguard` do mapping) e `instruction_addr`/`image_addr` (lab/native-test.mjs, SentinelKit `MetricKitCrashParser.swift`).
- O Sentinel não aceita debug files: só source maps JSON ≤5 MiB guardados inline no DO (`routes/sourcemaps.ts`, `project-state.ts` `handleUploadSourceMap`).
- Os guias em `lib/platforms.ts` avisam que não há simbolização (iOS linha ~325, Android ~366/377).

Resultado esperado: o dono envia dSYMs e mappings **por API, MCP, sentry-cli/plugin Gradle e painel**, automatizado no GitHub Actions e pelo Claude no Xcode; o Sentinel simboliza os frames antes do agrupamento, mostra quais arquivos faltam e reprocessa quando o arquivo chega depois. O README explica tudo o que a automação precisa.

Decisões já tomadas com o usuário: escopo = envio + simbolização; API própria **e** compatibilidade com sentry-cli.

## Andamento

| Fase | Estado |
|---|---|
| 0 — Spike | ✅ 25/11/2026: sentry-cli e protocolo verificados (abaixo). Symbolicator e Gradle ainda não rodados. |
| 1 — Armazenamento e API própria | ✅ branch `lab/debug-files` |
| 2 — sentry-cli | ✅ branch `lab/debug-files` (sem o upload legado multipart, ver abaixo) |
| 3 — MCP | ✅ branch `lab/debug-files` |
| 4 — Simbolização | pendente: precisa de Containers (Workers Paid), Docker no deploy e token R2 S3 |
| 5–6 — Painel e reprocessamento | pendente |
| 7 — SentinelKit | pendente (repositório `sentinel-ios`) |
| 8 — Documentação | README "Debug files", AGENTS.md, guias iOS/Android, `lab/` atualizados para as fases 1–3 |

### Resultados do spike (25/11/2026)

- **sentry-cli 3.8.2** aceita token `wst_` sem aviso. Rotas usadas: `GET /api/0/` (`info`), `GET` e `POST /api/0/organizations/{org}/chunk-upload/`, `POST /api/0/projects/{org}/{project}/files/difs/assemble/`. Nenhuma chamada ao upload legado `files/dsyms/` quando `accept` inclui `proguard`.
- `debug-files upload` divide o dSYM universal por arquitetura e manda um assemble por objeto, com `debug_id`. Os chunks vão no campo multipart `file_gzip`, nome = SHA-1 do conteúdo sem compressão.
- `upload-proguard` manda o nome `/proguard/{uuid}.txt` e **nenhum** `debug_id`; sem `--uuid`, o UUID é o uuid5 do conteúdo (namespace uuid5(DNS, "guardsquare.com")), igual ao que o Sentinel calcula.
- O `url` das opções de chunk upload precisa ser **relativo** (`organizations/{org}/chunk-upload/`): com URL absoluta montada a partir da requisição, o `wrangler dev` (rota de domínio próprio) reescreveu o host e o sentry-cli mandou os chunks para produção.
- O sentry-cli rejeita a resposta inteira se `dif.data.type` não for um tipo de objeto conhecido (`dbg`, `exe`…): mappings vão sem `type`.
- O mesmo `mapping.txt` com UUIDs diferentes (builds diferentes) é um arquivo novo: a deduplicação por SHA-1 só vale para Mach-O (o UUID faz parte dos bytes).
- O agente do Xcode guarda servidores MCP em `~/Library/Developer/Xcode/CodingAssistant/mcp-servers.json` (formato `mcpServers`); conexão HTTP ainda não testada pelo Xcode.
- Upload legado multipart (`POST files/dsyms/`, zip): não implementado. Só seria usado por sentry-cli antigo; confirmar com o plugin Gradle (que embute o próprio sentry-cli) antes de decidir.

## Arquitetura

```
CI / Xcode / agente ──► API própria  POST /api/projects/:slug/debug-files (≤95 MiB, streaming)
                   └──► sentry-cli   /api/0/.../chunk-upload + /files/difs/assemble (arquivos grandes)
                                  │
                                  ▼
                R2  p/{projectId}/dif/…  (+ chunks/{sha1}, expira em 24 h)
                ProjectState: tabela debug_files (debug_id → objeto, status)
                                  │
SDK ─► ingestão ─┬─ evento sem debug_meta ─► ProjectState (como hoje)
                 └─ evento com debug_meta ─► R2 + Queue ─► consumidor ─► Container Symbolicator
                                                              └─► evento simbolizado ─► ProjectState (fingerprint com nomes reais)
```

- **Motor**: [Symbolicator](https://github.com/getsentry/symbolicator) (FSL-1.1-MIT, permitido para uso próprio) num Cloudflare Container. Faz dSYM (`/symbolicate`) e ProGuard (`/symbolicate-jvm`). Os arquivos ficam no R2 no layout `unified` (`p/{projectId}/dif/unified/{id[0:2]}/{id[2:]}/debuginfo|proguard`), e cada requisição passa uma fonte S3 apontando para o R2 com o prefixo do projeto (isolamento por projeto).
- **Por que fila**: o Container tem cold start e dSYMs grandes; a resposta ao SDK não pode esperar. A mensagem da Queue tem limite de 128 KB, então o evento vai para `p/{projectId}/q/{eventId}` no R2 e a mensagem leva só o ponteiro.
- **Sem perda de evento**: se o Symbolicator falhar após as tentativas (teto ~10 min, abaixo da carência de 1 h do GC de anexos), o evento segue sem simbolização com a tag `symbolication:failed`.

## Fases (um PR por fase, nesta ordem)

### Fase 0 — Spike de compatibilidade (sem merge)
Verificar com ferramentas reais antes de escrever os endpoints:
1. `sentry-cli` atual (`debug-files upload`, `upload-proguard`, `info`) contra endpoints stub: quais rotas chama, se aceita token `wst_` (aviso de formato?), se manda `debug_id` no assemble, quando cai no upload legado.
2. Plugin Gradle do Sentry com `url` próprio e `telemetry = false`: confirmar que só fala com o Sentinel.
3. Symbolicator num Container com fonte S3 no R2 (`region: [nome, endpoint]`): um dSYM e um mapping de verdade.
4. Como o agente Claude do Xcode registra servidores MCP (onde fica a configuração). Nada disso vai para o README sem ter sido testado.

### Fase 1 — Armazenamento e API própria
- `ProjectState`: tabela `debug_files (id, kind 'macho'|'proguard', debug_id, arch, name, size, sha1, r2_key, status 'processing'|'ready'|'error', error, created_at)`, índice em `debug_id`; cota por projeto em bytes (padrão 5 GiB, ajustável como `maxAttachmentBytes`).
- Novo `lib/debug-file-store.ts` (layout de chaves, caps) seguindo o padrão de `lib/attachment-store.ts`; garantir que o GC de órfãos não toque em `dif/`, e que o purge de projeto (`p/{projectId}/`) leve tudo junto.
- Novo `lib/macho.ts`: lê cabeçalho fat/thin (32/64 bits) por range read do R2, extrai `LC_UUID` por arquitetura e detecta segmento `__DWARF`. Binário sem DWARF → erro claro ("isto é o executável, não o dSYM").
- ProGuard: `debugId` vem do cliente; sem ele, calcular o UUID v5 igual ao sentry-cli (namespace DNS `guardsquare.com` sobre o conteúdo, SHA-1 incremental de `@noble/hashes`, que já é dependência).
- Novo `routes/debug-files.ts` (montado em `/api/projects` no `index.ts`):
  - `POST /:slug/debug-files?kind=dsym|proguard&name=&debugId=` — corpo cru (aceita `Content-Encoding: gzip`), streaming para o R2, ≤95 MiB (limite de corpo da Cloudflare). Escopo `write`, qualquer membro (igual a source maps). Responde `201 {debugFiles:[…]}`.
  - `GET /:slug/debug-files` (paginado, filtros `kind`, `debugId`), `GET /:slug/debug-files/:id`, `DELETE /:slug/debug-files/:id` (owner/admin via `requireProjectManager`).
  - `POST /:slug/debug-files/check {debugIds?, issueId?, eventId?, release?}` → `found | missing | processing` por debug ID (a chamada que CI e agentes usam para confirmar).

### Fase 2 — Compatibilidade com sentry-cli (em `routes/api0.ts`, já público no Access via `/api/0/*`)
- `GET|POST /api/0/organizations/{org}/chunk-upload/` — opções (`chunkSize` 8 MiB, `maxRequestSize` 32 MiB, `hashAlgorithm: sha1`, `compression: [gzip]`, `accept: [debug_files, proguard]`) e recebimento multipart; cada chunk é conferido pelo SHA-1 e gravado em `chunks/{sha1}`.
- `POST /api/0/projects/{org}/{project}/files/difs/assemble/` — devolve `not_found` + `missingChunks`, ou registra a linha e enfileira a montagem (`created`/`assembling`/`ok`/`error` nas consultas seguintes). A montagem concatena os chunks em streaming no consumidor da fila (sem limite de 30 s) e passa pelo mesmo processamento da Fase 1.
- `POST /api/0/projects/{org}/{project}/files/dsyms/` — upload legado multipart (sentry-cli antigo / fallback).
- Expiração de `chunks/` em 24 h: regra de ciclo de vida do R2 em `lab/setup.sh` (o GC horário cobre o local).

### Fase 3 — MCP (`src/mcp/tools.ts`)
- Leitura: `list_debug_files`, `check_debug_files` (por issue, evento, release ou lista de IDs; diz o que falta).
- Escrita: `get_debug_file_upload` (devolve URL, cabeçalhos, comando `curl` e configuração do sentry-cli com o slug preenchido e o token como `$SENTINEL_AUTH_TOKEN`, nunca o valor), `upload_debug_file` (conteúdo base64 para arquivos pequenos, ≤8 MiB; acima disso aponta para a API/sentry-cli), `delete_debug_file` (`destructiveHint`, `confirm`), `reprocess_issue` (Fase 6).
- Prompt `upload_debug_files`: roteiro para o agente (achar `*.dSYM` no `.xcarchive`/DerivedData ou o `mapping.txt`, enviar, conferir com `check_debug_files`).
- Tudo via `ToolContext.callApi`, como as ferramentas existentes; testes em `test/mcp.test.ts`.

### Fase 4 — Simbolização
- `wrangler.jsonc` (e `template/`): Queue `sentinel-lab-symbolicate` (produtor + consumidor), classe Container `Symbolicator` (`@cloudflare/containers`, imagem `FROM getsentry/symbolicator:<versão fixa>` + config, `sleepAfter` ~10 min), nova migração de DO. Segredos `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` (token R2 só leitura no bucket).
- `routes/ingestion.ts`: eventos com `debug_meta.images` vão para R2 + fila em vez de `/ingest` direto; anexos continuam subindo como hoje e a metadata viaja junto. A resposta ao SDK passa a ser `200 {id}` sem `droppedAttachments` definitivos para esses eventos (documentar).
- Novo `lib/symbolicate.ts` (consumidor): pergunta ao ProjectState quais debug IDs existem; se nenhum, encaminha direto; senão chama o Container, mescla o resultado preservando os campos crus (`function`, `filename`, `lineno`, `symbol`, `data.symbolicated`, `debug_meta.images[].debug_status`; Android também desofusca o tipo da exceção) e encaminha para `/ingest` ou `/ingest-with-attachments`.
- `lib/fingerprint.ts` passa a agrupar pelos frames simbolizados (issues antigas não são reagrupadas; documentar).
- Testes: fake do Symbolicator por `globalThis.fetch`/stub de DO no padrão de `test/kaneo-fake.ts`; fixture pequena de dSYM real (gerada uma vez num Mac a partir de um programa mínimo) e de mapping em `test/fixtures/dif/`.

### Fase 5 — Painel (tokens + componentes do design system, sem estilos soltos)
- Configurações do projeto: seção "Debug files" (lista, tipo, debug IDs, arquitetura, tamanho, status, excluir; upload de DWARF/mapping com campo de UUID para ProGuard), no padrão da seção de source maps em `views/ProjectSettings.vue`.
- Issue/evento: card "Debug files" com cada imagem do `debug_meta` (encontrado/faltando/processando) e o comando para enviar o que falta; frames nativos mostram função/arquivo:linha, com o endereço cru alternável (`components/app/AppStackFrame.vue`).
- `lib/sentry-entries.ts` (`/api/0`) e `lib/event-summary.ts` (MCP `get_issue`, Kaneo) passam os frames simbolizados.

### Fase 6 — Reprocessamento
- Quando um debug file fica `ready`, marcar issues afetadas; `POST /api/projects/:slug/issues/:issueId/reprocess` (e `reprocess_issue` no MCP, botão no issue) re-simboliza os últimos N eventos guardados e atualiza os frames no lugar, sem mudar o agrupamento.

### Fase 7 — SentinelKit (outro repositório, `../SentinelIOS`, sessão própria)
Hoje só os crashes do MetricKit mandam `debug_meta`; erros capturados e `NSException` (`StackTraceBuilder.swift`) mandam endereço + `image_addr` sem UUID. Adicionar `debug_meta` com o UUID das imagens carregadas (dyld, `LC_UUID`) a todos os eventos com frames.

### Fase 8 — Documentação (entra junto com cada fase; revisão final aqui)
- **README.md**, nova seção "Debug files (dSYM and ProGuard/R8)" — só com o que foi testado:
  - Pré-requisitos do servidor: plano Workers Paid (Containers), Queue, token R2 só leitura, Docker no deploy; segredos e comandos.
  - Token: criar `wst_` com escopo `write`, guardar como secret `SENTINEL_AUTH_TOKEN` no GitHub.
  - Variáveis do sentry-cli: `SENTRY_URL`, `SENTRY_ORG=sentinel`, `SENTRY_PROJECT=<slug>`, `SENTRY_AUTH_TOKEN`.
  - GitHub Actions iOS (runner macOS): `xcodebuild archive` → `sentry-cli debug-files upload --wait <archive>/dSYMs` → `check`; alternativa só com `curl` na API própria.
  - GitHub Actions Android: plugin Gradle (`url`, `org`, `projectName`, `authToken` do secret, `autoUploadProguardMapping`, `telemetry = false`) e `./gradlew assembleRelease`.
  - Xcode: Run Script de build phase (`DWARF_DSYM_FOLDER_PATH`, input files, `ENABLE_USER_SCRIPT_SANDBOXING`).
  - Claude no Xcode: conectar o MCP do Sentinel (configuração confirmada na Fase 0), usar o prompt `upload_debug_files`, conferir com `check_debug_files`.
  - Tabela de endpoints e ferramentas MCP; limites (95 MiB por requisição, cota, retenção de chunks).
- `lib/platforms.ts`: passo "Upload debug files" nos guias iOS e Android; remover os avisos de "não simboliza".
- `AGENTS.md` (módulos, rotas, MCP, Container/Queue, armadilha de rollback com migração), `lab/README.md` (roadmap 1–4 concluído, link para a seção do README), `lab/cloudflare-resources.md`, `lab/setup.sh`/`teardown.sh` (Queue, Container, token R2, regra de ciclo de vida), `.github/workflows/lab-deploy.yml` (Docker para o build do Container). O token de deploy do GitHub precisa da permissão de Containers: o dono ajusta, agentes não mexem no token.

## Riscos e cuidados
- Deploy com migração de DO (Fase 4): `wrangler rollback` recusa voltar para antes dela; um smoke que falhe exige correção manual.
- Corpo de requisição limitado a 100 MB na Cloudflare: arquivos maiores só via chunk upload (sentry-cli).
- `lab/access.mjs`: nenhuma rota nova fora de `/api/0/*` precisa ser pública; as rotas `/api/projects/*` ficam atrás do Access como hoje (CI usa `/api/0` ou precisa de service token do Access — documentar).

## Verificação
- `pnpm lint`, `pnpm typecheck`, testes do worker e do painel, `node scripts/integration.mjs` a cada fase.
- Testes novos: parser Mach-O (fat/thin, sem DWARF), API (permissões, escopos, cota, gzip, 95 MiB), protocolo chunk/assemble/legado, ferramentas MCP, fila (sucesso, falha → evento sem simbolização, sem debug files → caminho direto), reprocessamento.
- Ponta a ponta local (`just dev-up`, Docker para o Container): enviar dSYM real com `sentry-cli`, mapping com o plugin Gradle num projeto exemplo, `lab/native-test.mjs` adaptado com os UUIDs reais → frames simbolizados no painel e em `get_issue` do MCP; crash antes do upload + upload + reprocessar.
- Produção: depois do deploy automático, repetir o envio pelo GitHub Actions de um app de exemplo e conferir com `check_debug_files`.
