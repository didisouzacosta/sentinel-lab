# Plano: integrações com página própria e passo a passo

**Criado:** 26/11/2026 · **Branch base:** `main` · **Branch:** `lab/integrations-page` · **Pacotes:** `packages/dashboard`, `packages/workers-sentinel` · **Kaneo:** SNT-16 · **Figma:** [Sentinel · Redesign do painel](https://www.figma.com/design/Q0WqtHyVVZQ5upP3aRar0n), página Telas → "Integrations"

## 1. Onde estamos

| Item | Hoje |
|---|---|
| Lugar | Slack, Kaneo e o webhook genérico são cartões no meio de `ProjectSettings.vue` (seções 4, 5 e 6 de 12), com navegação lateral por âncora |
| Credenciais | O token do Slack e a chave do Kaneo só são salvos junto com o canal ou o projeto. O `PUT` exige `channelId` / `kaneoProjectId`, e o `POST …/discover` valida, mas não guarda nada. Recarregar a página perde o que foi digitado |
| Carregamento | "Load channels" e "Reload projects" mostram só um spinner pequeno no botão. A lista fica vazia e desabilitada até a resposta chegar |
| Onde pegar cada credencial | Slack: link para criar o app pelo manifest, mas nada leva à página do Bot Token. Kaneo: texto solto "Create it in Kaneo under Settings → API keys", sem link |
| Estado da conexão | Só o texto "Connected" / "Not connected" no canto do cartão. O webhook do Kaneo aparece como alerta (`installed` / `in_use` / `failed`) |
| Dependências | `INTEGRATIONS_KEY` ausente vira um aviso dentro de cada cartão. A volta do Kaneo depende de o projeto do Kaneo não ter outro webhook: o Kaneo aceita um por projeto, e isso só é explicado depois de salvar |
| Componentes | Não há stepper: os passos numerados de `Connect.vue` são escritos à mão, e `App/SetupStep` está no inventário do redesign, mas nunca virou `.vue`. Também faltam badge de status de conexão, link externo e spinner avulso |

Arquivos de hoje:
- **Dashboard:** `views/ProjectSettings.vue`, `components/app/AppSlackIntegration.vue`, `components/app/AppKaneoIntegration.vue`, `views/IssueDetail.vue`.
- **Worker:** `routes/integrations.ts`, `routes/integrations-slack.ts`, `durable-objects/project-state.ts`, `lib/slack.ts`, `mcp/tools.ts`.

## 2. Objetivo

1. **Área Integrations própria**: um item no menu do projeto, uma visão geral com um cartão por integração e uma página por integração.
2. **Passo a passo didático**: passos numerados com estado (feito ✓, atual, bloqueado). Cada passo diz o que fazer, onde clicar e o que vem depois.
3. **Verify & save**: as credenciais são validadas **e persistidas** antes de escolher o destino. Em seguida, canais ou projetos carregam sozinhos, com carregamento visível.
4. **Links diretos** para onde está cada credencial. O valor nunca é lido nem copiado automaticamente; o usuário copia e cola.
5. **Status evidente**: ✓ Connected, Setup incomplete, Needs attention ou Not connected, com Disconnect e Send test à mão (pedido em 26/11/2026).
6. **Dependências claras**: o que bloqueia o quê é dito na tela antes de o usuário tropeçar.
7. **Tudo pelo design system**: as peças novas entram primeiro no Figma e no Vue, com o mesmo nome.

**Fora do escopo:**
- fluxo OAuth "Add to Slack" (troca do token colado por autorização);
- novas integrações (GitHub, Discord nativo);
- mudar o que cada integração entrega.

## 3. Decisões técnicas

| Tema | Decisão | Por quê |
|---|---|---|
| Lugar | Novo item **Integrations** no menu do projeto, entre Filters e Settings | Pedido explícito: separar e organizar. Settings fica mais curta |
| Rotas | `projects/:slug/integrations` (visão geral) e `…/integrations/{slack,kaneo,webhook}` (detalhe) | Uma página por integração deixa o passo a passo respirar e permite link direto (da issue, do MCP, de um aviso) |
| Webhook genérico | Sai de Settings e vira o terceiro cartão | Também é uma integração. Recebe o mesmo status visual |
| Settings | Perde os três cartões e ganha um cartão "Integrations moved → Open integrations" | Quem já conhece o caminho antigo não se perde |
| Persistência | `PUT` sem destino grava as credenciais validadas com `config.status = 'pending'` | É o "salvar e aplicar" pedido. Reaproveita a rota e o armazenamento (`handleSaveIntegration` não valida o conteúdo do config) |
| Entrega segura | `activeKaneo` / `activeSlack` retornam `null` sem `kaneoProjectId` / `channelId` | Hoje uma linha sem canal entraria no outbox (`queueSlackForIngest`) e falharia em loop |
| Status na API | `kaneoView` / `slackView` expõem `status` (`pending` \| `connected`), derivado de existir destino quando o campo falta | Integrações antigas continuam aparecendo como conectadas |
| App do Slack | O usuário cola o link da página do app (ou o App ID), guardado em `config.appId` | O Bot Token só existe em `api.slack.com/apps/<APP_ID>/oauth`, e o Sentinel não conhece o App ID. Se o `auth.test` devolver `app_id`, ele é preenchido sozinho (a conferir) |
| Links externos | Centralizados em `src/lib/integration-links.ts`, com fallback genérico | Um lugar só para corrigir se o Slack ou o Kaneo mudarem as rotas |
| Permissões | As de hoje: Slack e Kaneo só para owner e admin (`canManage`). O webhook genérico segue a regra atual do `PATCH` do projeto | Sem mudança de segurança |
| Textos | Interface em inglês, como o resto do painel | Os testes dependem dos textos |

### 3.1 Inventário de componentes novos (Figma ↔ Vue)

| Camada | Figma | Vue | Propriedades principais |
|---|---|---|---|
| UI | `Ui/Status` | `components/ui/UiStatus.vue` | `state`: `connected` (✓, verde), `pending`, `attention` (⚠), `off`. `label` opcional |
| UI | `Ui/ExternalLink` | `components/ui/UiExternalLink.vue` | `href`, `variant`: `inline` \| `button`, `disabled`. Sempre `target=_blank rel="noopener noreferrer"`, com o ícone `ExternalLink` |
| App | `App/SetupStep` | `components/app/AppSetupStep.vue` | `number`, `title`, `state`: `done` \| `current` \| `locked`, `lockedHint`. Slots `default` (conteúdo), `summary` (quando feito) e `actions` (ex.: Change) |
| App | `App/IntegrationCard` | `components/app/AppIntegrationCard.vue` | `name`, `icon`, `description`, `state` (`UiStatus`), `summary`, `to`. Ação `Set up` ou `Manage` |
| App | `App/ConnectionHeader` | `components/app/AppConnectionHeader.vue` | `state`, `title`, `summary`. Slot `actions` (Send test, Disconnect) |

**Como garantir:**
- cada componente novo entra na galeria `/__ui` (`views/dev/UiGallery.vue`) e ganha testes em `ui-components.test.ts`;
- `design-system.test.ts` continua passando: sem hex, sem paleta crua, sem `<svg>` solto;
- as telas só compõem componentes do inventário.

## 4. Desenho das telas

### 4.1 Visão geral (`/integrations`)

- **Cabeçalho:** `AppPageHeader` "Integrations", com o subtítulo "Send issues to the tools your team already uses."
- **Sem `INTEGRATIONS_KEY`:** um `UiAlert` warning no topo explica que o servidor precisa da chave. Slack e Kaneo ficam com o estado `off` e a ação desabilitada. O webhook continua disponível.
- **Três `AppIntegrationCard`:**

| Integração | Descrição | Resumo quando conectado |
|---|---|---|
| Slack | Post new issues, regressions and resolutions to a channel. | `#th-errors · error and above` |
| Kaneo | Turn issues into tasks and keep both sides in sync. | `TenhoHorario (TH) · two-way sync` ou `· one-way` |
| Webhook | Send issue alerts to any URL (Discord, your own endpoint). | domínio da URL |

- **Regras de estado do cartão:**
  - `connected` (✓ Connected): há destino e nenhum problema.
  - `pending` (Setup incomplete): as credenciais estão salvas, mas falta o destino.
  - `attention` (Needs attention): há `lastError`, a credencial ficou ilegível (`credentialsReadable: false`) ou o webhook do Kaneo está `in_use` ou `failed`. O resumo diz qual dos três.
  - `off` (Not connected).
- **Nota de dependências** no rodapé: "Slack and Kaneo work independently. Two-way sync with Kaneo needs its project webhook — Kaneo allows one per project."

### 4.2 Estrutura comum do detalhe

- **Breadcrumb:** `Integrations › Slack`.
- **`AppConnectionHeader`:**
  - mostra o estado grande (✓ ou ⚠), o título e o resumo;
  - quando conectado, tem as ações **Send test** e **Disconnect**. O Disconnect pede confirmação com `useConfirm`, em tom danger, e explica o que deixa de acontecer.
- **Lista de `AppSetupStep`:**
  - Os passos feitos aparecem resumidos, com **Change**.
  - O passo atual fica aberto.
  - Os seguintes ficam `locked`, com "Complete step N first".
  - Quando conectado, todos os passos ficam `done` e resumidos, e cada um pode ser reaberto com **Change**.
- **Carregamento:**
  - Os botões ficam com `loading` durante a ação.
  - As listas que dependem da API mostram `UiSkeleton` no lugar do select, com texto vivo: "Loading channels from Slack…" ou "Loading projects from Kaneo…".
- **Erros:** aparecem inline, em `UiAlert` error, dentro do passo, com **Try again**. Toast fica só para o resultado de save, test e disconnect.

### 4.3 Slack (`/integrations/slack`)

1. **Create the Slack app**
   - `UiExternalLink` botão "Create the app in Slack" abre o link com o manifest (como hoje). O manifest manual fica recolhido em `<details>`.
   - Campo **Your app's page**, com a ajuda: "After creating the app, paste the address of its page (api.slack.com/apps/A0…) or its App ID."
   - O campo aceita a URL ou o ID e extrai com `/\bA[A-Z0-9]{8,}\b/`.
   - O passo fica feito quando há App ID ou token salvo. O App ID é opcional: o link "I already have a token" pula para o passo 2.
2. **Install and copy the bot token**
   - `UiExternalLink` **Install to Workspace** → `https://api.slack.com/apps/<APP_ID>/install-on-team`.
   - `UiExternalLink` **Open OAuth & Permissions** → `https://api.slack.com/apps/<APP_ID>/oauth`, com a dica "Copy the *Bot User OAuth Token* (starts with `xoxb-`)". Sem App ID, o link é `https://api.slack.com/apps`.
   - Campo **Bot token** (password), depois o botão **Verify & save**:
     1. valida o formato e o `auth.test`;
     2. persiste com `status: pending`;
     3. o passo vira ✓ "Workspace TenhoHorario · bot @Sentinel";
     4. os canais começam a carregar.
3. **Choose the channel and alerts**
   - Canais carregam sozinhos, com skeleton. Opções `#nome` e `🔒nome`.
   - Ajuda: "Private channels show up once the bot is invited (/invite @Sentinel)", com **Reload channels**.
   - Filtros: Minimum level, Environments, Errors that come back e Resolutions.
   - **Save** → `connected`, com o toast "Slack connected to #canal".

### 4.4 Kaneo (`/integrations/kaneo`)

1. **Connect your Kaneo**
   - Campos **Kaneo URL** e **API key**.
   - `UiExternalLink` **Open Kaneo API keys** → `<URL>/dashboard/settings/account/developer`. A rota foi conferida no código do Kaneo: `apps/web/src/routes/_layout/_authenticated/dashboard/settings/account/developer.tsx`. O link fica desabilitado até haver uma URL válida.
   - **Verify & save**:
     1. lista os workspaces;
     2. persiste com `status: pending`;
     3. o passo vira ✓ "Connected to workspace Personal".
2. **Choose the project**
   - O select de workspace só aparece se houver mais de um; com um só, ele é escolhido sozinho.
   - Projetos carregam com skeleton. Escolher o projeto carrega as colunas.
3. **Columns and automation**
   - Colunas: "New tasks go to", "Resolved issues move to" e "Regressions move back to", com os padrões de hoje.
   - Create tasks automatically, Minimum level e Environments.
   - **Save** → `connected`.
4. **Two-way sync** (status do webhook)
   - `installed` → ✓ "Moving a task to Done in Kaneo resolves its issue."
   - `in_use` → explica "Kaneo allows one webhook per project and this project already has one", com:
     - `UiExternalLink` **Open project integrations in Kaneo** → `<URL>/dashboard/settings/projects/<id>/integrations`;
     - a sugestão "Use a separate Kaneo project for each Sentinel project";
     - o botão **Try again** (salva de novo).
   - `failed` → a mensagem do erro e **Try again**.

### 4.5 Webhook (`/integrations/webhook`)

- **Passo único:**
  - campo URL, com os exemplos Discord e endpoint próprio;
  - **Save**;
  - **Send test** quando houver URL;
  - **Remove**, com confirmação.
- **Estados:** `connected` (Configured) ou `off` (Not set up).

### 4.6 Outros pontos
- Página da issue: quando a integração não está conectada e o usuário é owner ou admin, os cartões Kaneo e Slack mostram o link "Set up in Integrations".
- `AppSidebar`: item **Integrations**, ícone `Plug`, ativo em `project-integrations` e `project-integration-*`.
- `Layout.vue`: o mapa `PAGE` ganha os títulos e o breadcrumb.

## 5. Interações e celular

| Interação | Como fica |
|---|---|
| Verify & save | Botão com `loading`. Em caso de erro, alerta inline no passo e foco no campo com problema. Em caso de sucesso, o passo vira `done`, o foco vai para o título do próximo passo e o carregamento começa |
| Carregar lista | `UiSkeleton` com `aria-live="polite"` e texto, e o select desabilitado até chegar |
| Passo bloqueado | Título com `aria-disabled`, mostrando a dica "Complete step N first". Não recebe foco nos campos |
| Change | Reabre o passo feito sem apagar o que está salvo. Cancelar volta ao resumo |
| Disconnect | `useConfirm` em tom danger, com texto específico por integração |
| Links externos | Abrem em nova aba, com o ícone e o texto "(opens in a new tab)" para leitor de tela |
| Sair com mudanças não salvas | Fora do escopo desta etapa. Como as credenciais persistem no Verify & save, a perda fica restrita aos filtros |

**Celular (375px):**
- os cartões da visão geral ficam em uma coluna;
- os passos ocupam a largura toda;
- os botões de link externo quebram em linha própria;
- o cabeçalho de status empilha as ações abaixo do título.

## 6. Etapas

Ciclo de cada etapa de tela, igual ao do redesign: Figma aprovado → implementação → `pnpm typecheck`, `pnpm lint` e testes → capturas em 1440px e 375px comparadas com o Figma → revisão → commit.

| # | Etapa | Arquivos | Entrega |
|---|---|---|---|
| 0 | Plano e tarefa | `docs/plano-integracoes-painel.md`, SNT-16 | Este documento revisado |
| 1 | Figma | Arquivo `Q0WqtHyVVZQ5upP3aRar0n` | Componentes da seção 3.1 e as telas visão geral, Slack, Kaneo e Webhook. Estados: não conectado, credenciais salvas, carregando, erro, conectado e atenção. Temas claro e escuro, e 375px. **Aprovação sua** |
| 2 | Backend | `routes/integrations.ts`, `routes/integrations-slack.ts`, `durable-objects/project-state.ts`, `lib/slack.ts`, `mcp/tools.ts`, testes, `AGENTS.md` | Estado `pending`, `status` e `workspaceName` nas views, `appId` no Slack, entrega que ignora o pending, `/test` → `409 integration_incomplete`, e o MCP entendendo `pending` |
| 3 | Componentes | `components/ui/UiStatus.vue`, `UiExternalLink.vue`, `components/app/AppSetupStep.vue`, `AppIntegrationCard.vue`, `AppConnectionHeader.vue`, `lib/integration-links.ts`, galeria e testes | Peças prontas e testadas |
| 4 | Telas | `router/index.ts`, `views/Layout.vue`, `AppSidebar.vue`, `views/ProjectIntegrations.vue`, `views/ProjectIntegration{Slack,Kaneo,Webhook}.vue`, `ProjectSettings.vue`, `IssueDetail.vue`, testes | Área Integrations funcionando, Settings enxuta e links na issue |
| 5 | Verificação | — | Checks, roteiro da seção 9 no browser e capturas 1440/375. **Revisão sua** |
| 6 | Entrega | — | PR → CI verde → merge → deploy → conferência em produção |

## 7. Figma

- Arquivo **"Sentinel · Redesign do painel"** (`Q0WqtHyVVZQ5upP3aRar0n`).
- Os componentes novos vão para a página **Componentes**, usando as variáveis da coleção `Sentinel · Cores` (modos Escuro e Claro).
- As telas vão para **Telas → "Integrations"**, em desktop, nos temas escuro e claro:
  - visão geral com cada estado de cartão;
  - Slack: passos 1, 2, 3 e conectado;
  - Kaneo: passos 1 a 4, incluindo o webhook `in_use`;
  - Webhook.
- Uma página **Celular** com as mesmas telas em 375px.

## 8. Kaneo

- **Tarefa:** SNT-16, "Etapa 12 · Integrações: página própria com passo a passo (Slack, Kaneo, Webhook)", no projeto "Sentinel · Redesign do painel".
- **Fluxo:** In progress enquanto a etapa anda, In review na revisão, Done depois do deploy conferido.

## 9. Critério de pronto

- [ ] Igual ao Figma, nos temas claro e escuro.
- [ ] As credenciais persistem no Verify & save e continuam lá ao recarregar a página.
- [ ] Carregamentos e erros visíveis em todos os passos.
- [ ] Os links abrem as páginas certas, conferidas no browser:
  - Slack: criar app, Install, OAuth & Permissions;
  - Kaneo: API keys e integrações do projeto.
- [ ] Integração pending nunca entrega. Há teste para isso.
- [ ] Interações conforme a seção 5: teclado, foco e aria.
- [ ] Funciona em 375, 768 e 1440px.
- [ ] Só componentes do inventário e tokens. `design-system.test.ts` passando.
- [ ] `pnpm typecheck` e `pnpm lint` passando, assim como os testes do dashboard e do worker.
- [ ] Nenhum `data-testid` ou texto usado em teste foi removido sem atualizar o teste.
- [ ] Em produção:
  - `tenho-horario-web` e `tenho-horario-api` aparecem ✓ Connected;
  - um erro de teste ainda cria a task (TH / THA) e posta em `#th-errors`;
  - `get_integrations` mostra `status`.

**Roteiro no browser**, com `wrangler dev` e o painel local:
1. **Slack:** criar o app → colar o link → Install / OAuth → token → Verify & save → recarregar a página (continua pending) → canal → Connected → Send test → Disconnect.
2. **Kaneo:** URL → API keys → Verify & save → projetos com skeleton → colunas → webhook ✓. Depois, um projeto com webhook `in_use`.
3. **Webhook:** salvar, testar e remover.
4. **Sem `INTEGRATIONS_KEY`:** conferir a tela.
5. **Teclado e 375px:** conferir a navegação e o layout.

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Integração pending entrar na entrega e falhar em loop | `activeKaneo` / `activeSlack` exigem destino. Há teste |
| Slack ou Kaneo mudarem as rotas das páginas | Links centralizados em `lib/integration-links.ts`, com fallback genérico. Conferir no browser antes do merge |
| Integrações antigas sem `status` | Status derivado de existir destino. Há teste de compatibilidade |
| MCP tratar pending como conectado | `get_integrations` mostra `status`, e `configure_slack` com token salvo só pede o canal. Há teste |
| Testes que dependem de textos e posições (`findAll('input')[0]`, nav com 12 seções) | Atualizar junto com cada tela. Preferir `data-testid` nos campos novos |
| `auth.test` não devolver `app_id` | O campo do link do app continua sendo o caminho principal |
