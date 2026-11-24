# Avaliação do Workers Sentinel — 24/11/2026

Fork testado: `ed3dnet/workers-sentinel@9d67e58` (MIT), rodando localmente com `wrangler dev` (Workers + Durable Objects SQLite + R2).
Objetivo: atender web hoje e ter caminho viável para simbolização de **dSYM (iOS)** e **ProGuard/R8 (Android)**.

## Veredito

**Como produto pronto: descartar.** Não tem nada de simbolização nativa, nem no roadmap, e o autor chama de "toy project".
**Como base para um fork próprio: viável.** Os dados brutos necessários são preservados, o código é pequeno e organizado, e todas as peças que faltam existem na Cloudflare (R2, Queues, Containers).

## Resultados dos testes

| Teste | Resultado |
|---|---|
| `@sentry/node` 10.78 (back-end) | ✅ Recebe exceções, mensagens, tags, usuário, breadcrumbs — **só com contorno `tunnel`** (ver bug 1) |
| `@sentry/browser` 10.78 + bundle minificado | ✅ Recebe; source map resolve arquivo:linha **só na tela**, no navegador |
| Crash iOS simulado (formato sentry-cocoa release) | ⚠️ Recebe e guarda `instruction_addr` + `debug_meta` (UUID do dSYM) intactos; painel mostra `(anonymous)` |
| Crash Android simulado (R8) | ⚠️ Recebe e guarda `debug_meta` proguard UUID; mostra nomes ofuscados `a.b.c` |

## Bugs / limitações encontrados

> Status em 24/11: **1, 2 e 4 corrigidos** na branch `lab/main` (ver README.md). 3, 5 e 6 seguem em aberto.

1. **IDs de projeto UUID quebram os SDKs JS/React Native atuais.** O `@sentry/core` trunca o projectId para os dígitos iniciais e, em build de debug, rejeita IDs não numéricos (`dsn.js`). Resultado: `POST /api/1/envelope/ 400`. Correção: ID numérico por projeto (pequena).
2. **Transações viram issues de erro** ("Unknown Error | POST /checkout") quando `tracesSampleRate > 0`.
3. **Agrupamento fraco:** mesma exceção com número diferente na mensagem (pedido 991/992/993) gerou 3 issues; crashes nativos sem nome de função agrupam só por tipo+mensagem (todo `EXC_BAD_ACCESS` vira uma issue só).
4. **Truncamento de frames errado:** `frames.slice(0, 100)` mantém os frames mais externos e descarta os do crash (o Sentry ordena do mais antigo para o mais recente). Stacks mobile/RN passam de 100 com frequência.
5. **Source maps resolvidos no navegador, não no servidor:** título, culprit e agrupamento usam o código minificado; cada deploy tende a gerar issues novas. Armazenados no SQLite do DO (máx. 5 MB, 200 por projeto).
6. **Sem compatibilidade com `sentry-cli`** (upload de source maps/dSYM/mapping no CI precisa de ferramenta própria).

## O que joga a favor de um fork

- Evento bruto salvo inteiro (`JSON.stringify(event)`): permite re-simbolizar eventos antigos quando o dSYM chegar depois.
- ~14 mil linhas de TypeScript (Hono), bem testado (~50 arquivos de teste), já tem superfície `/api/0` estilo Sentry e R2 configurado.
- Ingestão em streaming já separa Worker → DO; dá para inserir uma etapa de processamento antes do agrupamento.

## Arquitetura proposta para simbolização (100% Cloudflare)

```
SDK → Worker /envelope → Queue "process" → Worker de processamento
                                              ├─ JS: source map (R2) → frames originais
                                              ├─ iOS: debug_id → SymCache (R2) → símbolo/arquivo/linha
                                              └─ Android: proguard uuid → mapping (R2) → classe/método
                                         → fingerprint com frames simbolizados → ProjectState DO
CI → sentry-cli (API compatível de chunk upload) → R2 (debug files por debug_id / uuid)
```

Onde roda a simbolização (limite do Worker: 128 MB de memória; dSYMs têm dezenas a centenas de MB):

- **Opção A — Cloudflare Container** (até 4 vCPU / 12 GiB, dorme quando ocioso) com serviço Rust sobre a biblioteca `symbolic` (MIT) ou o Symbolicator (FSL-1.1-MIT, permitido para uso próprio). Aceita dSYM/mapping crus. Mais simples de acertar.
- **Opção B — Só Workers:** converter dSYM → SymCache e mapping → índice compacto **no upload** (no Container ou no CI) e consultar no Worker via `symbolic` compilado para WASM. Mais barato por evento, mais trabalho.

Recomendação: A para começar (upload cru + Container processa e gera SymCache no R2); B como otimização depois.

## Ordem sugerida do fork

1. Corrigir bugs 1, 2 e 4 (pequenos, destravam os SDKs oficiais).
2. Fila de processamento antes do agrupamento + mover source maps para R2 e resolver no servidor.
3. Armazenamento de debug files no R2 + API de upload compatível com `sentry-cli`.
4. Container de simbolização (dSYM + ProGuard) + exibição de frames nativos no painel.
5. Reprocessamento de eventos quando um debug file chega atrasado.

## Como reproduzir

```bash
cd packages/workers-sentinel
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to ../../.wrangler-state --var WEBAUTHN_ORIGINS:http://localhost:8787
node ../../_devenv/cloudflare/demo.mjs http://127.0.0.1:8787   # cria usuário/projeto demo
# em lab/: node-test.mjs, native-test.mjs, web/ (bundle minificado + source map) — ver lab/README.md
```
