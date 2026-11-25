# Plano: Sentinel 100% via MCP + Tem Horário saindo do Sentry

Escrito em 25/11/2026. Ainda não começou nada; este documento é para aprovar as decisões da seção 2 e a ordem das fases.

## 1. O que eu encontrei

### Hono, Deno, Workers: funciona igual?

Sim. O Sentinel não depende de linguagem nem de SDK: ele fala o **protocolo de ingestão do Sentry** (envelope em
`POST /api/{projectId}/envelope/`, autenticado pela chave pública do DSN). Qualquer coisa que mande um envelope funciona:
`@sentry/node`, `@sentry/cloudflare` (que cobre Hono no Workers), `@sentry/deno`, `@sentry/bun`, Python, Swift, PHP —
ou um `fetch` feito à mão.

O Tem Horário é exatamente o último caso. Apesar do Deno no repositório, ele **roda no Cloudflare Workers** (a API é
Hono no Workers, o site é Astro no Workers, o backup é outro Worker). O Deno é só a ferramenta de tarefas, testes e
lint. E ele **não usa SDK do Sentry**: `packages/adapters/observability/observability.ts` (`SentryErrorReporter`) e
`apps/web/src/lib/observability.ts` (`reportError`) montam o envelope na mão e mandam por `fetch`/`sendBeacon`. Trocar
para o Sentinel é, na essência, trocar o DSN.

### O único bloqueio de verdade

Os dois repórteres do Tem Horário colocam o DSN **só no cabeçalho do envelope** (`{"event_id", "dsn", …}` na primeira
linha). O Sentinel hoje só lê a chave de `?sentry_key=`, `X-Sentry-Auth` ou `Authorization: Basic`
(`routes/ingestion.ts`, `handleIngestion`) e responde **401 `missing_auth`** para esse envelope. O Sentry de verdade
aceita o DSN do cabeçalho do envelope (é como o *tunnel* do SDK de navegador funciona), então o certo é o Sentinel
aceitar também. Do lado do Tem Horário, acrescentar `?sentry_key=` resolve sozinho — faremos os dois.

### O que o Tem Horário usa do Sentry hoje

| Recurso | Onde | O Sentinel tem? |
|---|---|---|
| Erros da API (`tenho-horario-api`) e do site (`tenho-horario-web`), `environment` staging/produção, `release` `tenho-horario@x.y.z` | `container.ts`, `astro.config.mjs`, `core/domain/monitoring.ts`, `version.ts` | ✅ (ambientes, releases, filtros) |
| Alertas no Slack: erro novo, erro que voltou, pico (20+ em 15 min) | `docs/SLACK_PLAN.md`, regras 6372749/6372750/6372716 | ⚠️ só "erro novo" por webhook (o `text` do payload já serve para *incoming webhook* do Slack). Erro que voltou e pico não existem |
| Monitor de Cron `backup-th-db` (check-in "ok" do Worker de backup) | `services/backup/src/backup.ts` `checkIn`, secret `SENTRY_CRON_URL` | ❌ não existe |
| CSP `connect-src` liberando `*.ingest.sentry.io` | `core/domain/security-headers.ts` | — trocar pelo host do Sentinel |
| Texto legal ("Sentry: registro de erros") | `packages/ui/src/legal.pt-BR.ts` | — muda o texto (os dados passam a ficar na nossa conta Cloudflare) |

### O que o MCP faz hoje

O Sentinel não tem MCP próprio: a página **Connect** manda usar o `@sentry/mcp-server@0.51.0` apontado para o `/api/0`.
Isso cobre leitura e triagem de issues (`docs/compat-mcp-sentry.md`), mas **não cria, edita nem apaga projeto, nem
entrega DSN**. Criar projeto hoje só pela área de admin, que exige sessão de passkey e recusa token `wst_` de propósito
(AGENTS.md, "Security posture"). O MCP do Sentry até tem `create_project`/`create_dsn`, mas não tem apagar projeto, e o
`search_docs` dele ensina a configurar o Sentry, não o Sentinel.

### Integrações: o que existe dos dois lados

- **Sentinel hoje:** um único `webhook_url` por projeto, disparado só em issue nova (`lib/webhook.ts`). Nenhuma
  integração com credencial, nenhum link de issue para fora, nada que chegue de fora para dentro.
- **Kaneo** (`kaneo.adrianosouzacosta.com.br`, atrás do Access com *service token*): API de tarefas
  (`POST /task/{projectId}` com título, descrição, prioridade e coluna), **links externos em tarefa**
  (`/external-link/task/{taskId}`), etiquetas, um **webhook de saída assinado com segredo** (eventos `taskCreated`,
  `taskStatusChanged`, `taskCommentCreated`…), integração própria com GitHub/Gitea/GitLab e MCP próprio. Ou seja: dá
  para o Sentinel criar a tarefa **e** para o Kaneo avisar o Sentinel quando a tarefa for concluída.
- **GitHub:** Tem Horário, Sentinel e Kaneo estão em `github.com/didisouzacosta/…`. Uma issue no GitHub com uma etiqueta
  pode disparar o Claude Code numa GitHub Action, que analisa o erro no próprio repositório.
- **Sentry:** o Sentinel pode **repassar** os eventos que recebe para um DSN do Sentry — fica como tipo de integração
  genérico para outros projetos que queiram, mas **o Tem Horário não usa**: ele sai do Sentry por completo.

## 2. Decisões (preciso do seu ok)

1. **MCP próprio do Sentinel em `/mcp`** (recomendado), em vez de imitar mais rotas do Sentry para o MCP deles.
   Remoto, HTTP, autenticado pelo mesmo token `wst_`. Uma linha para conectar:
   `claude mcp add --transport http sentinel https://sentinel.adrianosouzacosta.com.br/mcp --header "Authorization: Bearer wst_…"`.
   O `/api/0` continua igual para quem já usa o MCP do Sentry.
2. **Token com escopo.** Hoje todo `wst_` pode ler e triar. Proposta: escopos `read`, `write` (triagem, notas,
   configurações do projeto) e `projects` (criar, apagar, trocar chave). Tokens que já existem ficam `read`+`write`,
   como hoje. Só uma sessão de **passkey** pode criar um token com `projects` — a mesma barra da área de admin. O token
   `projects` **não** dá acesso a usuários, configurações da instância nem auditoria; isso continua só no painel.
3. **Sua aprovação em cada ação que muda algo.** Em três camadas: (a) as ferramentas marcam `readOnlyHint` /
   `destructiveHint`, então o Claude Code pergunta antes de rodar qualquer uma que escreve (deixe liberadas só as de
   leitura); (b) `delete_project` exige repetir o slug no parâmetro `confirm`; (c) tudo que o MCP faz entra na auditoria
   com o nome do token.
4. **Monitor de Cron do backup:** como o Sentry sai por completo, o check-in passa a existir no Sentinel, no mesmo
   formato de URL do Sentry (`/api/{projectId}/cron/{slug}/{key}/?status=ok`), com alarme do Durable Object avisando
   nas integrações quando o "ok" não chega (fase 6). *(Decidido em 25/11: nada fica no Sentry.)*
5. **Alertas:** acrescentar "erro que voltou" (issue resolvida que recebe evento de novo) ao webhook. Pico fica para
   depois — o Slack do Tem Horário já recebe erro novo e o limite por hora do projeto segura enxurrada.
6. **Transporte no Tem Horário:** HTTP pelo DSN público (recomendado: igual para API, site e backup, e
   `/api/{id}/envelope/` já é público no Access). *Service binding* seria mais rápido só para os Workers, mas amarra o
   deploy do Tem Horário à existência do `sentinel-lab` nos dois ambientes.
7. **Onde ficam os segredos das integrações** (chave do Kaneo, *service token* do Access, token do GitHub):
   (a) recomendado — o MCP cria a conexão e devolve um **link de uso único para o painel**, onde você cola o segredo; a
   IA configura todo o resto, mas nunca vê nem repete o segredo; ou (b) o MCP aceita o segredo como parâmetro (mais
   rápido, mas o token passa pela conversa e fica na transcrição). Nos dois casos o segredo é guardado cifrado e nunca
   volta em resposta (só mascarado, `abcd…wxyz`).
8. **Destino padrão das tarefas de erro:** (a) recomendado — **Kaneo direto** (é onde você já trabalha; cada issue vira
   uma tarefa, com volta automática); (b) GitHub direto; (c) GitHub, e o Kaneo importa pela integração dele. Não ligar
   Kaneo direto **e** GitHub→Kaneo no mesmo projeto, ou cada erro vira duas tarefas.
9. **Análise automática do erro:** (a) recomendado — começar com a tarefa bem montada (stack, contexto, link e o
   comando para o agente pegar pelo MCP do Sentinel) e você manda "analisa a tarefa X" quando quiser; (b) também abrir
   issue no GitHub com a etiqueta `sentinel` e deixar uma GitHub Action com o Claude Code analisar e comentar (ou abrir
   PR) sozinha — custa tokens a cada erro novo, então vem com filtro (só produção, só `error`/`fatal`) e limite por dia.

## 3. Fases no Sentinel

### Fase 0 — Ingestão aceita o DSN do cabeçalho do envelope ✅ (25/11/2026, no código; ainda não publicada)
- `handleIngestion`: sem chave em query/cabeçalhos, lê a primeira linha do corpo (no máximo 64 KiB, também com gzip
  e com a linha partida em pedaços), tira a chave do `dsn` e devolve os pedaços lidos ao framer, então o corpo
  continua sendo lido uma vez só. O `projectId` do DSN tem que ser o mesmo da URL (senão `400 project_mismatch`);
  chave enviada por query/cabeçalho continua tendo prioridade.
- `sendBeacon` (`text/plain;charset=UTF-8`) e frames só com `function` funcionam.
- Testes em `packages/workers-sentinel/test/ingestion-envelope-dsn.test.ts`, com os envelopes exatamente como o Tem
  Horário monta hoje (API e navegador).

### Fase 1 — Plataformas e documentação, com uma fonte só ✅ (25/11/2026, no código; ainda não publicada)
- `packages/workers-sentinel/src/lib/platforms.ts`: catálogo (id, nome, resumo, passos com o DSN preenchido, CSP,
  notas, nível de suporte `verified`/`protocol` com onde foi testado, valor gravado em `projects.platform` e
  `platformForProject` para os valores antigos). Sem dependências, para o painel importar direto.
- 12 plataformas: Navegador, Node.js, **Cloudflare Workers (com Hono)**, **Astro**, **Deno**, Bun, Python, PHP, iOS,
  Android, **"sem SDK"** (envelope por `fetch`, o padrão do Tem Horário) e Outros.
- Usam o catálogo: página Connect (agora um seletor, com notas e o selo "tested with Sentinel"/"Sentry protocol") e o
  formulário de criar projeto do admin. O MCP vai usar na fase 3.
- Corrigido de passagem: projeto com plataforma `javascript-*` abria o guia do Android ("javascript" contém "java").
- README: seção "Platforms" com a tabela do que foi testado de verdade e do que é só "pelo protocolo". AGENTS.md:
  módulo `lib/platforms.ts`. (A seção do MCP e dos escopos entra com as fases 2 e 3.)
- O trecho "sem SDK" foi executado no Node 26 com o `fetch` interceptado: endpoint, DSN no cabeçalho e frames com
  arquivo/linha/coluna corretos.

### Fase 2 — Ciclo de vida do projeto pela API com token
- Rotas nativas aceitando token com escopo `projects`: criar (quem cria vira dono), editar (nome, plataforma, webhook,
  limite por hora, retenção, cabeçalhos a esconder), **trocar a chave do DSN** (nova; a chave antiga para de valer na
  hora — sem período de carência na primeira versão), apagar (reaproveita `purgeProjectState`).
- Coluna `scopes` nos tokens e checagem no `authMiddleware`; tela de tokens no painel mostra e escolhe os escopos.

### Fase 3 — Servidor MCP em `/mcp`
- Endpoint *Streamable HTTP* sem estado (cada chamada é um JSON-RPC; não precisa de Durable Object), com o SDK oficial
  de MCP em TypeScript, `Bearer wst_…`. Override público no Access para `/mcp` (`lab/access.mjs`, como foi feito com o
  `/api/0`); o Sentinel continua exigindo o token.
- Ferramentas:
  - Leitura: `whoami`, `list_projects`, `get_project` (com DSN e configurações), `list_platforms`,
    `get_setup_guide(project, platform)` (trecho pronto com o DSN do projeto, variáveis, CSP e como testar),
    `list_issues`, `get_issue`, `get_event`, `list_releases`.
  - Escrita (pergunta antes): `create_project`, `update_project`, `rotate_dsn`, `update_issue` (resolver/ignorar),
    `add_issue_note`, `send_test_event` (manda um evento de teste e confirma que chegou — fecha o "conectei"),
    `test_webhook`.
  - Destrutiva: `delete_project(project, confirm)`.
- Um *prompt* MCP `connect_project` com o roteiro: detectar a plataforma do repositório → criar o projeto → aplicar o
  trecho → `send_test_event`.
- Página Connect: aba MCP passa a mostrar o MCP próprio primeiro; o do Sentry fica como alternativa.
- Testes: cliente MCP de verdade contra o worker no vitest; atualizar `docs/compat-mcp-sentry.md`.

### Fase 4 — Integrações (tudo configurável pelo MCP)

O webhook único vira um sistema de integrações em duas camadas:

- **Conexão** (da instância, uma vez): credencial de um serviço — `kaneo` (URL, chave, *service token* do Access),
  `github` (token *fine-grained* só com Issues nos repositórios escolhidos), `sentry` (DSN de destino). Cifrada com um
  secret do Worker (`INTEGRATIONS_KEY`, AES-GCM). Segredo entra conforme a decisão 7.
- **Integração** (do projeto, quantas quiser): "quando acontecer X neste projeto, faça Y por esta conexão", com filtros.
  - Eventos: `issue.created`, `issue.regressed` (resolvida que voltou), `issue.resolved`, `cron.missed`.
  - Filtros: nível mínimo, ambientes (ex.: só `production`), release, limite de disparos por hora.
  - Tipos:

| Tipo | O que faz | Volta (de fora para dentro) |
|---|---|---|
| `slack` / `discord` | mensagem formatada (no lugar do `text` cru de hoje) | — |
| `webhook` | JSON assinado com HMAC (`X-Sentinel-Signature`) para qualquer endereço | — |
| `kaneo` | cria a tarefa no projeto e coluna escolhidos, com prioridade pelo nível (fatal→urgent, error→high, warning→medium), etiqueta `sentinel`, link externo para a issue e modelo de título (o Tem Horário usa `NN · [Pn] título`) | webhook do Kaneo `taskStatusChanged` → tarefa em "done" resolve a issue; issue que voltou move a tarefa de volta e comenta |
| `github` | abre issue no repositório com etiquetas | issue fechada no GitHub resolve a issue |
| `sentry` | repassa o evento recebido para o DSN do Sentry (com taxa de amostragem) | — |

- **Uma tarefa por issue, nunca uma por evento:** tabela `issue_links` (issue, integração, id e URL externos). Erro
  que volta reabre a mesma tarefa. O link aparece no painel, no `/api/0` (`annotations`) e no `get_issue` do MCP.
- **Corpo da tarefa:** título, onde (`culprit`), ambiente, release, quantas vezes e quantos usuários, primeira e
  última vez, os frames do próprio app (`inApp`), o link para a issue no Sentinel e a linha para o agente:
  "use `get_issue <id>` no MCP do Sentinel". Sem dado pessoal (mesma regra de hoje).
- **Rotas de volta** `POST /api/hooks/{integrationId}` (Kaneo e GitHub), com o segredo da integração conferido;
  override público no Access só para esse caminho.
- **Ferramentas MCP:** `list_connections`, `create_connection` (devolve o link do painel, decisão 7),
  `test_connection`, `delete_connection`; `list_integrations`, `create_integration`, `update_integration`,
  `delete_integration`, `test_integration` (manda um disparo de teste e mostra a resposta do destino).
  `create_integration` do tipo `kaneo` também cria, pela API do Kaneo, o webhook de volta apontando para o Sentinel,
  com o segredo — os dois lados ficam ligados numa chamada só.
- **Retentativa:** fila no `ProjectState` com alarme (1 min, 5 min, 30 min; depois desiste e marca a integração com o
  erro, visível no painel e no `list_integrations`). Falha numa integração nunca atrasa a ingestão.
- O `webhook_url` atual vira automaticamente uma integração `webhook`/`slack` (migração sem perda).

### Fase 5 — Análise automática (conforme decisão 9)
- Opção (b): workflow `.github/workflows/sentinel-triage.yml` no repositório do app, disparado por issue com a
  etiqueta `sentinel`, rodando o Claude Code com o MCP do Sentinel (token só de leitura, escopo `read`) para ler a
  issue, achar a causa no código e comentar a análise — ou abrir um PR quando a correção for pequena e óbvia. A
  ferramenta MCP `setup_triage_workflow(project, repo)` devolve o arquivo pronto para o agente colocar no repositório.
- Para o Kaneo, a mesma análise pode rodar como rotina agendada do Claude Code lendo a coluna de erros — fica para
  depois de a (b) provar que vale o custo.

### Fase 6 — Cron (conforme decisão 4)
- Monitores de Cron: tabela de monitores no `ProjectState`, rota de check-in compatível com o Sentry, alarme que
  dispara `cron.missed` nas integrações quando passa da margem; ferramentas MCP `create_monitor` / `list_monitors` /
  `delete_monitor`.

## 4. Tem Horário (no repositório dele, seguindo o git-flow e o changelog de lá)

1. **Pelo MCP do Sentinel**, com você aprovando: criar `tenho-horario-api` (Cloudflare Workers) e `tenho-horario-web`
   (Astro/navegador); limite por hora e retenção; e as integrações de cada um:
   - `slack` → `#th-errors` para produção (erro novo e erro que voltou) e `#th-staging` para staging;
   - `kaneo` → projeto TenhoHorario (`TH`), só produção, `error`/`fatal`, com o título no formato do projeto.
   - **Nada de Sentry:** o Tem Horário sai do Sentry por completo — sem repasse, sem período em paralelo.
2. **Código, sem nome de fornecedor:**
   - `SentryErrorReporter` → `EnvelopeErrorReporter`; `sentryRelease` → `errorRelease`;
     `MONITORING_PROVIDER: "envelope"`; `SENTRY_DSN` → `ERROR_DSN`; `PUBLIC_SENTRY_DSN` → `PUBLIC_ERROR_DSN`.
   - Endpoint com `?sentry_key=` (funciona mesmo antes da fase 0 ir ao ar).
   - Ler o stack direito (`at fn (arquivo:linha:coluna)` → `function`, `filename`, `lineno`, `colno`): hoje cada frame
     vira só `function` com a linha inteira, o que piora o agrupamento das issues. O site passa a mandar frames também.
   - CSP: troca `*.ingest.sentry.io` por `sentinel.adrianosouzacosta.com.br`.
   - Backup: `SENTRY_CRON_URL` → `CRON_CHECKIN_URL`, apontando para o Sentinel (se a decisão 4 for "a").
   - Texto legal: "Sentry" sai; os erros ficam na conta Cloudflare do próprio Tem Horário (sem dado pessoal, como já é).
   - Testes: `container.test.ts`, `version.test.ts`, `backup.test.ts`, mais o envelope chegando no Sentinel local.
   - Docs: AGENTS.md, README, PROJECT_CONTEXT.md, SLACK_PLAN.md, BACKUP_PLAN.md, VERSIONING_PLAN.md.
3. **Virada:** secrets no preview → deploy de preview → erro forçado + `send_test_event` → conferir no Sentinel pelo
   MCP (e a tarefa de teste no Kaneo) → produção. Com a produção conferida, segue a etapa final (seção 7).

## 5. Depois: os outros projetos

Com o MCP pronto, conectar um projeto é pedir "conecta este projeto no Sentinel". Os que hoje citam Sentry:
DuoTake, PotionPals e CleanerXcode (Swift — usam o SDK oficial; só o DSN muda, e o SentinelIOS já testa esse caminho),
KaneoCloudflare e OpenPanel (JS). Um de cada vez, depois que o Tem Horário estiver estável.

## 6. Ordem e tamanho

| Fase | O que entrega | Tamanho |
|---|---|---|
| 0 | Tem Horário consegue mandar erro sem mudar nada além do DSN | pequeno |
| 1 | Docs de plataforma com uma fonte só | médio |
| 2 | Projeto criado/apagado por token | médio |
| 3 | MCP próprio | grande |
| 4 | Integrações (Slack, webhook assinado, Kaneo com volta, GitHub, repasse ao Sentry) pelo MCP | grande |
| 5 | Análise automática no GitHub | pequeno |
| 6 | Cron | médio |
| TH | Tem Horário no Sentinel | médio |
| Final | Sentry removido do Tem Horário (código, Workers e conta do Sentry) | pequeno |

A migração do código do Tem Horário pode começar logo depois da fase 0 e ir em paralelo com as fases 1–3. A virada
para produção fica melhor depois das fases 4 e 6: elas trazem o Slack com erro que voltou, as tarefas no Kaneo e o
monitor de Cron do backup — o que falta para o Sentry sair sem perder nenhum aviso. O passo 1 da seção 4 é o primeiro uso real do MCP.

## 7. Etapa final — remover o Sentry do Tem Horário

Só depois de a produção estar no Sentinel e conferida (erro forçado chegou, aviso no Slack, tarefa no Kaneo, check-in
do backup recebido). Cada item que apaga algo é feito com a sua confirmação.

1. **Código** (no repositório do Tem Horário, pelo git-flow e changelog de lá):
   - nada de `Sentry` em nome de classe, função, variável, env ou comentário (`SentryErrorReporter`, `sentryRelease`,
     `MONITORING_PROVIDER: "sentry"`, `SENTRY_DSN`, `PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_CRON_URL`,
     `SENTRY_WEB_DSN` no `astro.config.mjs`);
   - CSP sem `*.ingest.sentry.io` / `*.ingest.us.sentry.io`;
   - texto legal sem o Sentry como serviço usado;
   - docs (AGENTS.md, README, PROJECT_CONTEXT.md, SLACK_PLAN.md, BACKUP_PLAN.md, VERSIONING_PLAN.md, LEGAL_PLAN.md)
     falando do Sentinel; o que for histórico fica só no changelog.
2. **Workers:** apagar os secrets `SENTRY_DSN` (API, preview e produção) e `SENTRY_CRON_URL` (backup) com
   `wrangler secret delete`.
3. **Conta do Sentry** (pelo MCP do Sentry): apagar os projetos `tenho-horario-api` e `tenho-horario-web`, as regras de
   alerta 6372749, 6372750 e 6372716, o monitor de Cron `backup-th-db` e, se nenhum outro projeto usar, a integração
   do Sentry com o Slack do workspace `tenhohorario`.
4. **Conferência:** `grep -riI sentry` no Tem Horário (fora de `node_modules`, `.wrangler`, `dist` e do changelog) não
   acha nada; `deno task check` passa; um erro forçado em produção chega ao Sentinel e nenhuma requisição sai para
   `sentry.io` (aba de rede do navegador e logs do Worker).
