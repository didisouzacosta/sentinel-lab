# Plano: fechar os riscos abertos da simbolização

A simbolização (fase 4 de [`plano-debug-files.md`](plano-debug-files.md)) e o endurecimento contra eventos malformados (PR #14) estão em produção. A análise de 27/11/2026 deixou dois riscos aceitos. Este plano fecha os dois.

## Andamento

| Fase | Risco | Estado |
|---|---|---|
| 1 — Um Symbolicator por projeto | Isolamento | ✅ 27/11/2026, branch `lab/symbolicator-per-project`: verificado ponta a ponta com dois projetos (duas instâncias, nenhum pedido barrado por engano) |
| 2 — Orçamento de simbolização por projeto | Custo | ✅ 27/11/2026, branch `lab/symbolication-budget` (com a decisão 3: cota de 5000 eventos/h para projetos móveis novos) |
| 3 — Contrapressão global | Custo | ✅ 27/11/2026, branch `lab/symbolication-backpressure`: `max_concurrency` 4, espera máxima de 10 min |
| 4 — Cache de resultados | Custo | opcional, decidir depois de medir a fase 2 |
| 5 — Documentação e sinais | Os dois | ✅ README, AGENTS.md, `lab/` e plano de debug files atualizados a cada fase. A regra de WAF segue opcional (ação do dono) |

## Os riscos

**R1 — Isolamento entre projetos depende do container.** Hoje uma única instância do Symbolicator (`getByName('symbolicator')`) atende todos os projetos. O Worker responde a qualquer `GET /dif/{projectId}/` que venha dela. Se um dSYM ou mapping malicioso explorasse uma falha de parsing no Symbolicator, o processo comprometido poderia pedir arquivos de qualquer projeto. Ele não tem internet, segredos nem acesso direto ao R2, mas leria debug files alheios.

- **Quem consegue:** qualquer membro com escopo `write` em algum projeto (é quem envia debug files).
- **Impacto:** leitura de dSYMs e mappings de outros projetos (símbolos e caminhos de código-fonte, não segredos de runtime).

**R2 — Custo e abuso.** Quem tem o DSN (público) e um debug ID guardado (os dois estão no binário do app) consegue gerar trabalho de container a cada evento.

- **Como é hoje:** com `max_events_per_hour = 0` (o padrão), não há teto. A cota, quando existe, já é checada antes da fila (PR #14).
- **Impacto:** custo do container (memória cobrada pelo provisionado: `standard-1` = 4 GiB ≈ US$ 0,036 por hora acordado, além das ~6 h/mês incluídas), fila e R2. E simbolização atrasada para os eventos legítimos.

## Fase 1 — Um Symbolicator por projeto (R1)

**Ideia:** cada projeto usa a própria instância do container. O Worker só serve os arquivos de um projeto para a instância desse projeto.

- `callSymbolicator` passa a usar `env.SYMBOLICATOR.getByName(projectId)`.
- `serveDebugFiles` recebe o contexto do handler de saída e confere `ctx.containerId === env.SYMBOLICATOR.idFromName(projectIdDoCaminho).toString()`. Se não bater, responde 403 e registra um log `symbolication.isolation_violation` com o par de ids (sinal de container comprometido).
- **Por que isso fecha o risco:** o `containerId` vem do runtime (`ctx.id` do Durable Object do container, `@cloudflare/containers` `ContainerProxy` props), não do processo dentro do container. A instância do projeto A não consegue se passar pela do projeto B. Um Symbolicator comprometido só enxerga os arquivos do próprio projeto, que o atacante, membro dele, já podia baixar.
- **Alternativa descartada:** token HMAC por projeto na fonte `sentry`. Com um container compartilhado, o processo comprometido veria os tokens de todo projeto simbolizado enquanto estivesse comprometido; só reduz o risco, não fecha.

**Consequências:**

| Tema | Hoje | Depois | Ação |
|---|---|---|---|
| Instâncias | 1 | uma por projeto com crash recente | `max_instances` 1 → 10 (decisão abaixo) |
| Tempo acordado | 10 min após o último evento | por projeto | `sleepAfter` 10 min → 3 min, para o custo não multiplicar por projeto |
| Cold start | raro | primeiro crash de cada projeto após 3 min parado (~5–10 s) | aceitável: o SDK já recebeu o 200, o atraso fica só no painel |
| Cache do Symbolicator | compartilhado, separado por `scope` | por instância | nenhuma |
| Migração de DO | — | não precisa (mesma classe, nomes novos) | a instância `symbolicator` antiga só dorme |

- **Capacidade esgotada:** com mais projetos ativos ao mesmo tempo do que `max_instances`, o start falha. Tratar como erro temporário (retry, já existe), e na última tentativa guardar sem simbolização (`symbolication: failed`, já existe). Teste para isso.
- **Testes:** o handler recusa `containerId` de outro projeto e loga; `callSymbolicator` usa o nome do projeto; um evento de A não consegue arquivo de B mesmo forjando o caminho; capacidade esgotada cai no fallback.
- **Verificação:** ponta a ponta local (`wrangler dev` + Docker) com dois projetos, `docker ps` mostrando duas instâncias; em produção, o `symbolication-test` e um segundo projeto de teste.

## Fase 2 — Orçamento de simbolização por projeto (R2)

**Ideia:** um teto de simbolizações por hora por projeto, separado da cota de eventos. Passou do teto, o evento é guardado na hora sem simbolização, sem perda.

- Nova configuração `maxSymbolicationsPerHour`. Padrão **500** (decisão abaixo); `0` desliga a simbolização do projeto. Editável por `PATCH /api/projects/:slug`, pelo MCP (`update_project`) e, na fase 5 do plano de debug files, pelo painel.
- `/symbolication/admit` passa a contar a admissão de forma atômica (tabela de contadores por hora, como `rate_limit_counters`). Acima do teto, devolve `admit: false, reason: 'budget'`.
- A ingestão marca esses eventos com `symbolication: skipped`, para o usuário entender por que o crash veio com endereços.
- Uma linha de log por projeto e hora quando o teto é atingido; a contagem da hora aparece em `GET /api/projects/:slug/debug-files` (campo `symbolication`).
- **Testes:** o evento 501 da hora é guardado direto com `skipped`; a virada de hora libera; `0` desliga; a contagem não sobe para eventos não admitidos (sem arquivo, com a cota estourada).

## Fase 3 — Contrapressão global (R2)

**Ideia:** limitar o trabalho simultâneo e o tempo de espera na fila, para um surto (ataque ou crash em massa legítimo) não acumular atraso nem custo.

- `max_concurrency` no consumidor da fila (por exemplo, 4): no máximo 4 simbolizações ao mesmo tempo no total. Junto com `max_instances`, isso põe teto no custo por hora.
- **Idade máxima:** se o evento esperou mais de 10 min (a partir de `parkedAt`), o consumidor guarda sem simbolizar (`symbolication: skipped`, motivo `backlog`). Assim nenhum evento fica horas parado e a fila se esvazia sozinha depois de um surto.
- Ajustar o fallback por tentativas (`SYMBOLICATE_LAST_ATTEMPT`) para continuar abaixo da carência de 1 h do GC de anexos com a nova concorrência.
- **Testes:** evento com `parkedAt` antigo é guardado sem chamar o container; a configuração de concorrência está no `wrangler.jsonc` (teste de config).

## Fase 4 — Cache de resultados (opcional)

**Ideia:** o mesmo crash vindo de muitos aparelhos custa uma única chamada ao container.

- A chave do cache usa offsets relativos à imagem (`instruction_addr - image_addr` por `debug_id`), porque o ASLR muda os endereços absolutos a cada execução.
- Guarda só o que a mesclagem usa (`function`, `symbol`, `filename`, `abs_path`, `lineno`, `lang`, `status`, a ordem das inlines) por 24 h, no ProjectState.
- **Por que opcional:** reduz custo em crash em massa legítimo, mas um atacante varia os endereços e escapa do cache. A fase 2 é quem fecha o abuso. Decidir com os números da fase 2 em produção.

## Fase 5 — Documentação e sinais

- README ("Symbolication"): o isolamento por instância, o orçamento e a idade máxima, os valores de `symbolication` (`done`, `missing`, `failed`, `skipped`), como mudar o orçamento.
- AGENTS.md: `getByName(projectId)`, a checagem do `containerId`, a contagem na admissão, os limites.
- [`plano-debug-files.md`](plano-debug-files.md): trocar "Riscos que ficam" pelo link para este plano e o estado final.
- `lab/cloudflare-resources.md`: instâncias por projeto, `max_instances` e `sleepAfter` novos.
- **Opcional, fora do código (ação do dono):** regra de rate limiting do WAF da Cloudflare em `/api/*/envelope` por IP, como primeira barreira antes do Worker.

## Decisões para o dono

Aprovadas em 27/11/2026 como sugeridas: `max_instances` 10, orçamento padrão de 500 simbolizações por hora, projetos novos de iOS/Android com cota de 5000 eventos por hora, cache (fase 4) só depois de medir a fase 2.


1. **`max_instances` da fase 1:** 10 cobre o lab com folga. Custo máximo teórico com todas acordadas o tempo todo: 10 × US$ 0,036/h, mas o `sleepAfter` de 3 min faz o uso real ficar perto do tempo de crash de cada projeto.
2. **Orçamento padrão da fase 2:** 500 simbolizações por hora por projeto. Para um app pequeno, um crash por minuto o tempo todo cabe com folga.
3. **Cota de eventos padrão:** projetos novos de iOS/Android já nascerem com `max_events_per_hour` (por exemplo, 5000)? Hoje nascem ilimitados.
4. **Fase 4:** fazer agora ou só se os números pedirem.

## Riscos e cuidados

- A fase 1 muda o nome da instância: o primeiro crash de cada projeto depois do deploy paga um cold start. Não há migração de DO, então `wrangler rollback` continua possível para versões depois da `v2`.
- O orçamento conta admissões, não simbolizações bem-sucedidas: um evento que falhar depois de admitido ainda consome uma unidade (é conservador, de propósito).
- `max_concurrency` baixo demais atrasa crash em massa legítimo. Começar com 4 e olhar a idade dos eventos na fila.

## Verificação (cada fase)

- `pnpm lint`, typecheck, testes do worker e do painel, `node scripts/integration.mjs`.
- Ponta a ponta local com o container real (`wrangler dev` com `enable_containers: true` numa cópia da config, Docker ligado).
- Depois do deploy automático: um crash ofuscado no projeto `symbolication-test` (e no segundo projeto de teste na fase 1), conferido pelo MCP (`get_event`), e os logs (`wrangler tail`) para os sinais novos.
