# Plano: redesign do painel do Sentinel

**Criado:** 25/11/2026 · **Branch base:** `lab/main` · **Pacote:** `packages/dashboard`

## 1. Onde estamos

| Item | Hoje |
|---|---|
| Framework | Vue 3.5 + Pinia + Vue Router 4, Vite 6 |
| CSS | Tailwind **3.4** com `tailwind.config.js`, PostCSS + Autoprefixer |
| Estilo | 10 classes globais em `src/style.css` (`.btn`, `.input`, `.card`, `.badge-*`) e o resto utilitário direto nas views |
| Tokens | Só paletas `primary` (sky), `error`, `warning`. Cores `gray-*` espalhadas pelas views |
| Tema | Classes `dark:` presentes, mas não há como alternar o tema; segue só o sistema e de forma incompleta |
| Ícones | SVG inline copiado em cada view |
| Estrutura | Listas feitas de `div` (issues, top issues, usuários), menu lateral repetindo o mesmo bloco de classes 9 vezes, sem `aria-current`, sem *skip link*, modais feitos com `div` |
| Responsivo | Barra lateral fixa de 256px; quase nenhuma classe responsiva (0 em 16 dos 21 arquivos); tabelas e filtros estouram em tela pequena |
| Interações | 13 modais feitos com `div` (sem Esc, sem foco preso, sem `aria-modal`, rolagem da página por trás continua; só o PasskeyNag tem `role="dialog"`). 6 `confirm()`/`alert()` nativos (Issues, ApiTokens, Settings, ProjectFilters). Menu de Snooze não fecha ao clicar fora nem funciona por teclado. Copiar DSN/token não dá retorno visual. Erros de ação somem no console |
| Testes | 39 testes de componente (vitest + happy-dom), apoiados em `data-testid` e textos |

Telas (21 arquivos, ~6.500 linhas): Login, Register, ForcePasswordChange, PasskeyNag, Layout, Projects, ProjectOverview, Issues, IssueDetail, EventDetail, AttachmentList, Releases, ReleaseDetail, ProjectFilters, ProjectSettings, Settings, ApiTokens, AdminUsers, AdminProjects, AdminSettings, AdminAudit.

## 2. Objetivo

1. **Stack moderna:** Tailwind **v4** com configuração no próprio CSS (`@theme`), plugin oficial do Vite, sem `tailwind.config.js`, PostCSS e Autoprefixer.
2. **Design system pequeno e próprio:** tokens semânticos (superfície, texto, borda, destaque, níveis de erro) e componentes base em `src/components/ui/`.
3. **HTML semântico e acessível:** `header`/`nav`/`main`/`section`, tabelas de verdade para dados tabulares, `<dl>` para metadados, `<dialog>` nativo para modais, foco visível, `aria-current`, contraste AA.
4. **Visual de ferramenta de observabilidade:** denso, legível, escuro por padrão com tema claro completo, níveis de erro com cor consistente.
5. **Todas as interações corrigidas e responsivas** (pedido em 25/11/2026): modais, confirmações, menus, avisos, estados de carregando/vazio/erro e a visão no celular passam a seguir um padrão único (seção 5).
6. **Sem regressão:** nenhuma mudança de API, rota, store ou comportamento. Os 39 testes continuam passando a cada tela.

6b. **Padronização total via design system** (pedido em 25/11/2026): toda cor, tipografia, espaçamento e peça de interface sai de tokens e componentes. As telas só compõem componentes; nada de classe de cor/tamanho solta nas views. Cada componente do Figma tem um componente Vue com o mesmo nome e as mesmas propriedades.
7. **Nova seção "Setup" por projeto** (pedido em 25/11/2026): um lugar fixo para configurar os **SDKs** e o **MCP**, em vez do guia que hoje só aparece na lista de issues vazia.

Fora do escopo: trocar Vue, mudar a API do worker, outras funcionalidades novas.

## 3. Decisões técnicas

| Tema | Decisão | Por quê |
|---|---|---|
| Tailwind | `tailwindcss@4` + `@tailwindcss/vite` | Configuração em CSS, build mais rápido, variáveis CSS nativas para os tokens |
| Tokens | `@theme` com variáveis semânticas (`--color-surface`, `--color-fg`, `--color-border`, `--color-accent`, `--color-level-fatal…debug`) definidas para claro e escuro | Uma troca de tema só muda variáveis, sem `dark:` em cada classe |
| Tema | `@custom-variant dark` ligado a `[data-theme=dark]`; padrão = sistema; escolha salva em `localStorage`; alternador no menu do usuário | Controle explícito sem perder o padrão do sistema |
| Fonte | Inter Variable + JetBrains Mono via `@fontsource-variable/*` (arquivos servidos pelo próprio Worker) | A CSP atual só permite `font-src 'self'`; não precisa mudar a CSP |
| Ícones | `lucide-vue-next` (só os ícones usados entram no bundle) | Fim dos SVGs copiados; consistência |
| Componentes base | `UiButton`, `UiInput`, `UiSelect`, `UiCheckbox`, `UiCard`, `UiBadge` (nível/status), `UiTable`, `UiTabs`, `UiDialog`, `UiConfirm`, `UiMenu`, `UiToast`, `UiDrawer`, `UiEmptyState`, `UiSpinner`/`UiSkeleton`, `UiAlert`, `UiPageHeader`, `UiStat`, `UiCode` |
| Interações | `UiDialog` sobre `<dialog>` nativo + `showModal()`; composables `useConfirm()` e `useToast()` (Promise) substituem `confirm()`/`alert()`; `UiMenu` com `popover` nativo e navegação por setas | O navegador já dá foco preso, Esc, camada superior e `inert` no resto da página; menos código próprio | Elimina repetição; cada tela passa a ser composição |
| Variantes | `class-variance-authority` + `tailwind-merge` (`cn()`) | Padrão comum para variantes de componentes com Tailwind |
| Classes globais | `.btn`, `.input`, `.card`, `.badge-*` ficam como *alias* durante a migração e são removidas na última etapa | Permite migrar uma tela de cada vez |
| Testes | Manter todos os `data-testid` e textos usados pelos testes; acrescentar testes de componente para os `Ui*` | Revisão segura tela a tela |

### 3.1 Inventário de componentes (Figma ↔ Vue)

Regra: se aparece em mais de um lugar ou tem comportamento, é componente. Nome e propriedades iguais nos dois lados (o Figma usa as mesmas variantes que as *props* do Vue).

| Camada | Figma | Vue (`src/components/…`) | Propriedades principais |
|---|---|---|---|
| Fundação | Variáveis `Sentinel · Cores` (Escuro/Claro), estilos de texto, ícones `Icon/*` | `style.css` (`@theme`), `lucide-vue-next` | — |
| Base | `Button` | `ui/UiButton.vue` | `variant` primary·secondary·ghost·danger, `size` md·sm, `icon`, `loading` |
| Base | `Field` (input/select) | `ui/UiInput.vue`, `ui/UiSelect.vue` | `state`, `icon`, `invalid` |
| Base | `FormField` | `ui/UiFormField.vue` | `label`, `help`, `error` (liga `aria-describedby`) |
| Base | `Checkbox` | `ui/UiCheckbox.vue` | `checked`, `indeterminate` |
| Base | `Badge/Level`, `Badge/Status`, `Tag` | `ui/UiBadge.vue`, `ui/UiTag.vue` | `level`, `status`, `mono` |
| Base | `Tab` | `ui/UiTabs.vue` | `items`, `modelValue` |
| Base | `Switch` | `ui/UiSwitch.vue` | `checked` (`role="switch"`, `aria-checked`), `label` |
| Base | `Avatar` | `ui/UiAvatar.vue` | `name` |
| Superfície | `Card`, `Card/Header`, `DL/Row` | `ui/UiCard.vue`, `ui/UiDescriptionList.vue` | `title`, `actions` (slot), `mono` |
| Superfície | `CopyField`, `Code` | `ui/UiCopyField.vue`, `ui/UiCode.vue` | `value`, `language`, `copied` |
| Feedback | `Alert`, `EmptyState`, `Skeleton/Row`, `Toast` | `ui/UiAlert.vue`, `ui/UiEmptyState.vue`, `ui/UiSkeleton.vue`, `ui/UiToast.vue` + `useToast()` | `tone`, `action` |
| Sobreposição | `Dialog`, `Confirm`, `Menu` + `Menu/Item`, `Backdrop`, `Sheet` (celular) | `ui/UiDialog.vue`, `ui/UiConfirm.vue` + `useConfirm()`, `ui/UiMenu.vue`, `ui/UiDrawer.vue` | `title`, `description`, `tone`, `confirmLabel` |
| App | `App/Sidebar`, `NavItem`, `App/TopBar`, `App/MobileTopBar`, `App/BottomActionBar` | `app/AppSidebar.vue`, `app/AppNavItem.vue`, `app/AppTopBar.vue` | `active`, `crumbs` |
| App | `App/PageHeader`, `App/Stat`, `App/IssueRow`, `App/IssueCard` (celular), `App/ProjectCard`, `App/SetupStep` | `app/*.vue` | dados da tela |
| App | `App/Subnav` (seções de uma página longa) | `app/AppSectionNav.vue` | `items` (`id`, `label`, `danger`); destaca a seção visível e rola até a escolhida |
| App | `App/FilterRow`, `App/SuggestionRow`, `App/SourceMapRow` | marcação em `ProjectFilters.vue` / `ProjectSettings.vue` com `UiTag`, `UiSwitch`, `UiButton` | dados da tela |

Como garantir:
- **Teste de padronização** (etapa 0): um teste do vitest varre `src/views/**` e falha se encontrar paleta crua (`gray-`, `sky-`, `red-`…, hex), `fixed inset-0`, `confirm(`, `alert(` ou `<svg` inline. Começa com uma lista de exceções (as telas ainda não migradas) que encolhe a cada etapa; ficou vazia na etapa 10. Na etapa 11 o `style.css` passou a desligar a paleta padrão do Tailwind (`--color-*: initial`), então uma classe crua como `bg-gray-500` nem gera CSS, e o teste também confere que o arquivo não tem paletas nem aliases antigos.
- **Code Connect** (opcional, etapa 11): ligar cada componente do Figma ao `.vue` correspondente.

## 4. Direção visual

- **Escuro por padrão**: fundo quase preto azulado, superfícies em camadas, bordas sutis.
- **Destaque**: violeta/índigo para ações e navegação ativa (substitui o azul-céu atual).
- **Níveis**: fatal (rosa), error (vermelho), warning (âmbar), info (azul), debug (cinza), sempre com o mesmo par de cores em badge, barra lateral da linha e gráfico.
- **Densidade**: linhas de 44px na lista de issues, números tabulares (`font-variant-numeric: tabular-nums`), monoespaçada para IDs, stack traces e código.
- **Estrutura do app**: barra lateral com troca de projeto no topo, logo abaixo o atalho fixo **Connect · SDKs & MCP** (sempre visível, com ou sem projeto), navegação do projeto (Visão geral, Issues, Releases, Filtros, Configurações), Administração separada e o **menu do usuário** no rodapé; barra superior com breadcrumb e ações da página.
- **Menu do usuário** (pedido em 25/11/2026, substitui o botão solto de sair): o bloco avatar + nome + e-mail é um botão que abre um menu para cima com: cabeçalho (nome, e-mail, papel e como a sessão foi aberta: passkey ou senha), *Account settings*, *Security & passkeys*, *API tokens*, *Connect an AI agent (MCP)*, seção *Theme* (System / Light / Dark, com marca no atual) e, separado no fim, *Sign out* em vermelho. Mesmo comportamento de todo `UiMenu` (teclado, Esc, clique fora).

## 5. Interações e celular

### 5.1 Padrões de interação

| Interação | Hoje | Como fica |
|---|---|---|
| **Modal** (criar/editar usuário, resetar senha, membros, criar projeto, gerar token, filtros) | `div` com `fixed inset-0`, fecha só clicando fora | `UiDialog` (`<dialog>` + `showModal()`): título ligado por `aria-labelledby`, foco vai para o primeiro campo e volta para o botão que abriu, Esc e clique no fundo fecham (exceto se houver alteração não salva, que pede confirmação), rolagem da página travada, botão primário à direita, `Enter` envia o formulário. No celular abre como folha de baixo para cima (*bottom sheet*) em tela cheia |
| **Confirmação destrutiva** (excluir issues, mesclar, revogar token, apagar passkey, excluir filtro/projeto/usuário) | `confirm()` do navegador | `useConfirm({ title, body, confirmLabel, tone: 'danger' })` → `UiConfirm`. Botão de confirmar em vermelho e com o verbo ("Delete 2 issues"); ações irreversíveis de alto impacto (excluir projeto) pedem digitar o nome |
| **Erro de ação** | `alert()` ou só `console.error` | `useToast().error(...)` com a mensagem do servidor; erros de formulário aparecem embaixo do campo (`aria-describedby`) |
| **Sucesso / cópia** | nada | Toast curto ("DSN copied", "2 issues resolved") e o botão Copy vira "Copied ✓" por 2 s. Toasts em `aria-live="polite"`, empilhados no canto inferior direito (topo no celular), somem em 4 s e pausam no hover |
| **Menu** (Snooze, ações da linha, troca de projeto, menu do usuário) | `v-if` sem fechar ao clicar fora | `UiMenu` com `popover`: fecha ao clicar fora/Esc, setas ↑↓ navegam, `Enter` escolhe, foco volta ao gatilho |
| **Ações em lote** | barra acima da lista | Barra fixa no topo da tabela enquanto houver seleção; contador `aria-live`; `Esc` limpa a seleção |
| **Carregando** | spinner central | `UiSkeleton` no formato da tela (linhas da tabela, cartões); botões mostram spinner e ficam `aria-busy` durante a ação |
| **Vazio** | textos soltos | `UiEmptyState` com ícone, frase e próxima ação (ex.: lista de issues vazia → "Set up an SDK" leva ao Setup) |
| **Erro de carregamento** | faixa vermelha | `UiAlert` com "Try again" |
| **Navegação** | só links | `aria-current="page"` no item ativo, *skip link* "Skip to content", título da aba do navegador por tela (`Issues · web-frontend · Sentinel`) |
| **Teclado** | parcial | Tudo alcançável por Tab com foco visível (anel accent de 3px); atalhos opcionais na lista de issues: `j`/`k` linha, `x` seleciona, `r` resolve, `?` mostra os atalhos |
| **Movimento** | — | Transições de 150 ms em modais, menus e gaveta; desligadas com `prefers-reduced-motion` |

### 5.2 Celular e tablet

| Faixa | Layout |
|---|---|
| **< 768px (celular)** | Barra superior com botão de menu, nome do projeto e ações principais. Barra lateral vira **gaveta** (`UiDrawer` sobre `<dialog>`, fecha com Esc, clique fora ou ao navegar). Conteúdo com padding de 16px |
| **768–1023px (tablet)** | Barra lateral recolhida só com ícones (64px), expande ao passar o mouse/tocar |
| **≥ 1024px** | Layout completo do Figma |

Regras por tipo de conteúdo:
- **Tabelas** (issues, usuários, projetos, tokens, auditoria): no celular cada linha vira cartão empilhado (título, badges, números numa linha só); colunas secundárias somem. A tabela continua `<table>` para leitores de tela.
- **Filtros**: no celular ficam atrás de um botão "Filters (2)" que abre uma folha de baixo para cima; os chips de filtro ativo continuam visíveis.
- **Ações em lote**: no celular viram barra fixa no rodapé da tela.
- **Detalhe da issue**: coluna lateral (Event/User/Tags) desce para baixo do stack trace; botões Resolve/Ignore/Snooze ficam numa barra fixa no rodapé; stack trace rola na horizontal dentro do cartão, sem quebrar a página.
- **Gráficos**: mantêm a proporção e mostram menos rótulos no eixo X.
- **Alvos de toque** de pelo menos 40×40px; nada depende de hover.
- **Modais** viram folha de baixo para cima em tela cheia.

## 6. Etapas (uma tela por vez)

Cada etapa segue o mesmo ciclo: **Figma aprovado → implementação (visual + todas as interações da tela + versão celular) → `pnpm typecheck`, `pnpm lint`, testes do dashboard → capturas no navegador em 1440px e 375px comparadas com o Figma → sua revisão → commit**. Só então a próxima etapa começa.

| # | Etapa | Arquivos | Entrega |
|---|---|---|---|
| 0 | **Fundação** | `package.json`, `vite.config.ts`, `style.css`, remove `tailwind.config.js`/`postcss.config.js`, `src/components/ui/*`, `src/lib/cn.ts`, `src/composables/useTheme.ts` | Tailwind 4, tokens, fontes, ícones, componentes base, incluindo `UiDialog`, `UiConfirm`/`useConfirm`, `UiToast`/`useToast`, `UiMenu`, `UiDrawer`. As telas ficam visualmente iguais (aliases) |
| 1 | **Estrutura do app** | `Layout.vue`, `App.vue`, `index.html` | Nova barra lateral, troca de projeto (`UiMenu`), atalho fixo *Connect · SDKs & MCP*, menu do usuário (conta, segurança, tokens, MCP, tema, sair), gaveta no celular, barra recolhida no tablet, *skip link*, títulos da aba, região de toasts |
| 2 | **Autenticação** | `Login.vue`, `Register.vue`, `ForcePasswordChange.vue`, `PasskeyNag.vue` | Tela de entrada em duas colunas, passkey em destaque |
| 3 | **Projetos** | `Projects.vue` | Grade de cartões com plataforma e contagem |
| 4 | **Visão geral do projeto** | `ProjectOverview.vue` | Cartões de métrica, gráfico de tendência com eixo e tooltip, top issues em tabela |
| 5 | **Issues** | `Issues.vue` | Barra de filtros (folha no celular), chips de tags, ações em lote fixas, `useConfirm` no excluir/mesclar, `useToast` no lugar do `alert()`, tabela semântica que vira cartões no celular, atalhos de teclado, estado vazio levando ao Setup |
| 6 | **Detalhe da issue e do evento** | `IssueDetail.vue`, `EventDetail.vue`, `AttachmentList.vue` | Cabeçalho com ações, Snooze em `UiMenu`, stack trace legível, `<dl>` para tags e contexto, anexos, barra de ações fixa no celular |
| 7 | **Releases** | `Releases.vue`, `ReleaseDetail.vue` | Tabela de releases e detalhe |
| 8 | **Configurações do projeto** | `ProjectFilters.vue`, `ProjectSettings.vue` | Seções em cartões com navegação lateral, DSN copiável com retorno, membros e filtros em `UiDialog`, excluir projeto digitando o nome |
| 8b | **Connect: SDKs e MCP** (nova, de acesso fácil) | `views/Connect.vue` (rota global `/setup`, com `?project=` e `?tab=mcp`; `projects/:slug/setup` redireciona), `router/index.ts`, atalho fixo na barra lateral, item no menu do usuário, link no estado vazio de `Issues.vue` | Aba **SDKs** (escolhe o projeto): DSN copiável, escolha da plataforma (Browser, Node.js, Cloudflare Workers via RPC, Python, iOS, Android, outros SDKs Sentry) e passos com o DSN já preenchido. Aba **MCP**: criar token de API, comando pronto para o Claude Code e JSON para outros clientes, apontando o MCP do Sentry (0.51.0, fixado) para o `/api/0` desta instância; aviso lista só o que funciona (ver `docs/compat-mcp-sentry.md`) |
| 9 | **Conta** (Settings já migrada em 25/11/2026: os cartões estavam sem espaçamento interno) | `Settings.vue`, `ApiTokens.vue` | Perfil, senha, passkeys, tokens; `useConfirm` ao apagar passkey e revogar token; token novo mostrado uma vez em `UiDialog` com cópia |
| 10 | **Administração** | `admin/*.vue` | Tabelas (cartões no celular), os 10 modais de admin em `UiDialog`, confirmações em `UiConfirm` |
| 11 | **Limpeza** | `style.css`, testes | Remove aliases antigos; varredura final: nenhum `confirm(`/`alert(`/`fixed inset-0` restante, axe sem erros, contraste, teclado e 375/768/1440px em todas as telas. **Feito (25/11/2026):** aliases (`.btn`, `.card`, `.input`, `.label`, `.badge-*`) e paletas `primary/error/warning` removidos, paleta padrão desligada (o CSS gerado só perdeu as classes antigas), borda e placeholder padrão nos tokens; axe-core 4.14 (WCAG 2.2 AA) sem violações nas telas de projeto, conta e Connect, claro e escuro, com modal e menu abertos; blocos de código roláveis agora recebem foco pelo teclado. Ficaram de fora: login/cadastro e administração no axe (exigem sair da sessão ou passkey) e o Code Connect (opcional) |

## 7. Figma

Arquivo **"Sentinel · Redesign do painel"** com:
1. **Fundação:** cores (claro e escuro), tipografia, espaçamento, raio, níveis.
2. **Componentes:** botão, campo, select, badge de nível/status, cartão, abas, linha de tabela, alerta, estado vazio.
3. **Telas (desktop, tema escuro):** Login, Projetos, Visão geral, Issues, Detalhe da issue, Setup (SDKs e MCP), Configurações do projeto, Administração · Usuários.
4. **Interações:** modal de formulário, confirmação destrutiva, menu (Snooze), toasts.
5. **Celular (375px):** Login, Issues com gaveta fechada e aberta, filtros em folha, Detalhe da issue com barra de ações fixa.

As telas restantes (Register, Evento, Release, Filtros, Conta/Tokens, Admin Projetos/Configurações/Auditoria) seguem os mesmos padrões e são desenhadas no Figma no início da etapa delas, antes da implementação.

## 8. Kaneo

Projeto **"Sentinel · Redesign do painel"** (sigla **SNT**, workspace Personal, criado em 25/11/2026) com uma tarefa por etapa (0 a 11), na ordem acima, cada uma com a lista de arquivos e o critério de pronto. A tarefa vai para *Em andamento* quando a etapa começa, *Em revisão* quando a captura de tela está pronta para você, e *Concluído* depois da sua aprovação e do commit.

## 9. Critério de pronto (por etapa)

- Igual ao Figma aprovado (claro e escuro).
- A tela só usa componentes do inventário (3.1) e tokens; o arquivo sai da lista de exceções do teste de padronização.
- `pnpm typecheck`, `pnpm lint` e `pnpm --filter @workers-sentinel/dashboard test` passando.
- Nenhum `data-testid` ou texto usado por teste removido sem atualizar o teste.
- Navegável por teclado, foco visível, sem erro no console.
- Funciona em 375px, 768px e 1440px, igual ao Figma do celular quando houver.
- Modais, menus e confirmações da tela seguem a seção 5.1 (Esc, foco, teclado, `aria-*`); nenhum `confirm()`/`alert()` ou overlay `fixed inset-0` sobrando nos arquivos da etapa.
- Testes de componente cobrindo abrir/fechar/confirmar nas interações novas da etapa.

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Tailwind 4 muda nomes/escala de algumas utilidades (`shadow-sm`, `rounded`, `ring`) | Etapa 0 roda a ferramenta oficial `npx @tailwindcss/upgrade` e revisa o diff antes de qualquer mudança visual |
| happy-dom com `<dialog>` e `popover` nativos | Testar `showModal()`/`showPopover()` na etapa 0; se faltar, *polyfill* só no ambiente de teste |
| Testes atuais clicam em `confirm()` simulado (`window.confirm` mockado) | Ao trocar por `useConfirm`, atualizar esses testes na mesma etapa para clicar no botão do `UiConfirm` |
| Bundle maior com fontes e ícones | Fontes variáveis com `unicode-range` latino; ícones importados um a um |
| O MCP do Sentry (`@sentry/mcp-server`, modo `--host`) pode chamar rotas do `/api/0` que o Sentinel não tem | Antes da etapa 8b, um teste rápido ligando o MCP a uma instância local e listando quais ferramentas funcionam. A aba MCP mostra só o que foi verificado |
| Mudança grande demais por revisão | Uma tela por commit, com captura antes/depois |
