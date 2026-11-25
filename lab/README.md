# Sentinel Lab

**Produção:** https://sentinel.adrianosouzacosta.com.br — painel atrás do Cloudflare Access; só a ingestão dos SDKs é pública.

Experimento: rastreamento de erros compatível com os SDKs do Sentry rodando **só na Cloudflare**, com o objetivo de chegar à simbolização de **dSYM (iOS)** e **ProGuard/R8 (Android)**.
Base: fork MIT do [workers-sentinel](https://github.com/G4brym/workers-sentinel) (branch `main`). Avaliação inicial: [RELATORIO.md](RELATORIO.md).

## Isolamento (fácil de apagar)

- **Local:** tudo vive nesta pasta (código, testes, estado local em `.wrangler-state/`). Apagar a pasta apaga o projeto.
- **Cloudflare:** todo recurso usa o prefixo `sentinel-lab` e está listado em [cloudflare-resources.md](cloudflare-resources.md). O domínio é um Custom Domain do Worker (sai junto com ele).
- **Apagar da Cloudflare:** `lab/teardown.sh` (pede confirmação digitada).
- **Isolamento máximo:** usar uma conta Cloudflare só para o lab (`npx wrangler login` com ela).

## Rodar localmente (sem conta Cloudflare)

```bash
npx pnpm@9.15.0 install
cd packages/workers-sentinel
npx wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to ../../.wrangler-state --var WEBAUTHN_ORIGINS:http://localhost:8787
```

Em outro terminal, na raiz:

```bash
node _devenv/cloudflare/demo.mjs http://127.0.0.1:8787
```

Isso cria `demo@sentinel.local` / `sentinel-demo-password` e o projeto "CLI Feedback". Pegue o DSN no painel (Settings) e troque `https://` por `http://` para uso local.

## Testes de integração com os SDKs oficiais (pasta `lab/`)

```bash
cd lab && npm install
SENTINEL_DSN="http://<key>@127.0.0.1:8787/1" npm run test:node        # back-end
npm run build:web && npm run serve:web                               # abrir http://127.0.0.1:8788/?dsn=<DSN>
SENTINEL_PROJECT=1 SENTINEL_KEY=<key> npm run test:native              # crashes iOS/Android simulados
```

Suíte do Worker: `cd packages/workers-sentinel && npx vitest run`.

## Deploy na Cloudflare

```bash
npx wrangler login
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… SENTINEL_ADMIN_EMAILS=voce@exemplo.com lab/setup.sh
```

`setup.sh` liga o Access (`lab/access.mjs`) **antes** do deploy — o primeiro usuário cadastrado vira admin. Depois: entre pelo Access, cadastre-se, registre uma passkey e entre com ela para liberar a área de administração (criar projetos).

## Mudanças do lab em relação ao upstream

| # | Mudança | Por quê |
|---|---|---|
| 1 | DSN com ID numérico de projeto (`ingest_id`), com migração automática; DSNs antigos com UUID continuam aceitos | Os SDKs JS e React Native atuais truncam ou rejeitam IDs não numéricos |
| 2 | Transações (performance) são descartadas na ingestão | Viravam issues falsas de "Unknown Error" |
| 4 | Pilhas com mais de 100 frames são cortadas no meio, preservando o local do crash | O corte antigo descartava justamente os frames do crash |
| — | Worker, R2 e scripts renomeados para `sentinel-lab*` | Isolamento e teardown |

Testes novos: `test/lab-sdk-compat.test.ts` e `test/lab-ingest-id-migration.test.ts`.

## Próximos passos (roadmap do lab)

1. Fila de processamento antes do agrupamento; source maps no R2, resolvidos no servidor.
2. ✅ Armazenamento de debug files no R2 + upload compatível com `sentry-cli`, API e MCP (README, seção "Debug files"; plano em `docs/plano-debug-files.md`).
3. Container de simbolização (dSYM + ProGuard) e exibição de frames nativos no painel.
4. Reprocessamento quando o debug file chega depois do crash.
