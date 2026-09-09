# Retrospectiva intent-factory — campanha `intent-factory-retrospective-20260829` (2026-08-29 → 2026-09-01)

Objetivo: entender por que a campanha levou **3 dias e 9 horas** e **~4,77M weighted input tokens** para fechar 3 checkpoints, e especificar as mudanças para a próxima campanha ser mais rápida, mais barata e observável pela sessão principal.
Evidência: `.runs/campaigns/intent-factory-retrospective-20260829/{HANDOFF.md,journal.jsonl,usage-ledger.json}`, `.runs/intent-factory-retrospective-*/STATUS.md`.

## 1. Evidência

### 1.1 Números da campanha

| Métrica | Valor |
|---|---|
| Relógio (primeiro intent → último run terminal) | 2026-08-29 04:12Z → 2026-09-01 13:21Z (~81 h) |
| Runs/takes lançados | 17 |
| Takes que fecharam checkpoint | 3 (take9, take16, take17) |
| Invocações de provider no ledger | 24 |
| Weighted input (época 1 / época 2) | 2,43M (teto 1,5M — estourou) / 2,34M (teto 6M) |
| Raw input / cache reads / output | 1,75M / 30,2M / 171k |
| Maior consumidor isolado | take6: 1,85M weighted (**39% do total**) sem fechar checkpoint |

### 1.2 Destino de cada take (classe de falha)

| Classe | Takes | Custo típico |
|---|---|---|
| Quota/disponibilidade de provider | take2 (Codex usage limit), take11 (GLM 429/5h), take7 (juiz esgotou rollout antes do JSON) | take inteiro + espera de reset (~horas) |
| Orçamento de época esgotado | run inicial (7 nós, 6 blocked), take3, take6 | 1º nó estrangulou o grafo; 6 checkpoints nunca executaram |
| Protocolo de resultado frágil (pré-correção) | take5 (2× wall-clock), take8 (prosa em vez de JSON) | reinvocação worker+juiz completa |
| Rejeição de gate por DoD não-mecânico | take12, take13, take14, take15 | 4 dispatches extras para 1 checkpoint (fechado só no take16) |
| Scope gate por packet incompleto | take10 (5 writeFiles legítimos ausentes) | dispatch inteiro sem executar nada |
| Ambiente/durabilidade | take13 (ENOSPC transitório), take15 (controller morreu), take11 (snapshot sem `toolPolicy`, não resumível) | trabalho válido convertido em take novo |

### 1.3 O que a campanha entregou (diff verificado: 355 testes, 353 pass, 2 skip)

- Arquivo canônico de resultado do worker (`results/<node>.json`) com adoção exact-once no resume e fail-closed para arquivo inválido.
- Rotação automática de sessão por limiar de turnos/contexto com handoff determinístico e identidade de continuação.
- Tool policy (foreground/output bounds) via hooks em claude/glm; `exec-jsonl` capability false (executável arbitrário não prova enforcement).
- Regressões do supervisor corrigidas (conversão única de `--interval`, root failure causal, attention para exaustão de provider).
- Eventos duráveis de progresso de campanha (`campaign.progress`, `node.terminal`, `run.terminal`) com cursor de consumo confirmado.
- Retrospectiva obrigatória: `campaign close` recusa sem evento `retrospective` no journal (`note --kind retrospective`).
- Regressão pega no fechamento: os gates rodavam suíte focada; a suíte completa achou 10 testes quebrados (`intent-settlement`, `handoff`) cujos helpers assumiam a semântica antiga de adoção — corrigidos para reter também o arquivo canônico ao reabrir a janela de crash.

## 2. Diagnóstico (por que demorou)

1. **Quota de provider sem failover**: 3 takes morreram por 429/limite antes ou durante o trabalho. O schema já tem `runtimeFailover.routes`, mas vazio; cada falha virou re-contrato manual e espera de reset (a maior perda de relógio junto com a serialização).
2. **Grafo grande × época pequena**: 7 nós sob teto de 1,5M; o primeiro nó consumiu tudo e bloqueou os outros 6. A recuperação virou cadeia de micro-contratos de 1 nó (take4→take17) — o anti-padrão que o próprio SKILL.md descreve: cada take paga contrato, dispatch, preflight e cache frio, e mantém a sessão de controle cara ativa.
3. **Rejeições de gate em linguagem natural**: o ciclo take12→13→14→15→16 gastou 5 dispatches para 1 checkpoint porque o DoD tinha itens sem prova mecânica ("mechanically exercised", "memory-bounded") que cada juiz reinterpretava. Custo: ~1,1M weighted só nesse ciclo.
4. **Verificação do gate ⊂ verificação do repo**: os juízes aprovaram takes com a suíte focada verde enquanto a suíte completa quebrava — a regressão só apareceu no fechamento manual. Aprovação de gate final precisa rodar o conjunto `allowedVerification` inteiro.
5. **Feedback zero para a sessão principal**: os eventos existem e são duráveis, mas `deliveredAt: null` em todos — não há `INTENT_FACTORY_NOTIFY_BIN` configurado. A sessão só fica sabendo quando o usuário reinvoca o /goal, e cada reinvocação paga attach+watch+status + o contexto inteiro da sessão. O pedido do usuário (report a cada 10 min) era impossível por construção.
6. **Custo fixo de reinvocação do orquestrador**: cada retomada de sessão consome 3+ processos de CLI e releitura de HANDOFF/status; com 8+ sessões na linhagem, esse overhead se acumula em cima do custo de modelo.

## 3. Spec de melhorias (próxima campanha)

Metas: campanha equivalente em **≤1 dia de relógio** e **≤1,5M weighted** (‑70% em ambos), zero takes perdidos por quota/protocolo, sessão principal informada de evento material em **≤10 min**.

### P0 — feedback para a sessão principal

**P0.1 Notify-bin de arquivo + watcher na sessão.** Entregar `scripts/notify/append-file.mjs` como `INTENT_FACTORY_NOTIFY_BIN` default: appenda eventos coalescidos (bounded ≤1 KiB) em `.runs/control/session-inbox/<session-id>.jsonl`. No harness (Claude Code), a sessão arma UM watcher de background sobre o inbox no início do turno (tail detached que re-invoca a sessão quando o arquivo cresce) em vez de polling ou reinvocação cega. Coalescência no bin: só `node.terminal`, `run.terminal`, `attention` e mudança de fase; máximo 1 wake por 10 min.
**P0.2 `campaign sync`.** Um subcomando que faz attach + watch --cursor + status numa invocação única e emite um resumo bounded — corta o custo fixo de cada retomada de 3+ processos para 1.

### P0 — tempo

**P0.3 Failover automático de runtime em quota.** Popular `runtimeFailover.routes` (worker: glm→claude→codex; judge: sol-low→sonnet) e, quando o 429 anuncia horário de reset menor que o deadline do nó, o supervisor detached agenda o retry no reset em vez de terminar o take. take2 e take11 (≥1 dia de relógio somado) teriam sido absorvidos sem intervenção.
**P0.4 Paralelismo com isolamento por worktree.** `maxParallel > 1` para nós sem interseção de `writeFiles`, cada worker em `git worktree` próprio com merge serializado pelo controller. É a pendência P0.2 da retrospectiva anterior e a maior alavanca de relógio restante.

### P0 — tokens

**P0.5 DoD mecânico.** `validate` exige que cada item do DoD referencie um comando de `verification` ou um path de evidência; itens de julgamento levam `judgment: true` explícito. O juiz recebe a checklist com os resultados determinísticos prontos e só arbitra os itens de julgamento; rejeição que não cita um item é inválida. Teria evitado o ciclo take12→16 (~1,1M weighted).
**P0.6 Gate final roda a verificação completa.** O último nó de cada fase (e qualquer take que feche o último checkpoint) executa o `allowedVerification` inteiro do plano, não a suíte focada do packet. Teria pego a regressão de `intent-settlement`/`handoff` no take16.
**P0.7 Micro-contrato serial vira erro.** `validate` falha (não avisa) contrato de 1 nó sem flag `--targeted-fix`, e `runner.mjs contract prune <run-dir>` gera o contrato de continuação com nós done removidos e capsules como seed — follow-up barato e mecânico em vez de re-autoria manual.

### P1 — robustez

**P1.1 Scope pre-check.** `validate --against <worktree>` compara `writeFiles` com o diff presente/esperado e falha antes do dispatch (take10 teria custado 0 tokens).
**P1.2 Snapshot tolerante na leitura.** `resume` valida snapshots históricos com a versão que os escreveu (ou os trata como advisory), em vez de recusar o run inteiro (take11).
**P1.3 Teto por nó derivado.** Orçamento de nó = min(`maxInvocationTokens`, restante-da-época ÷ nós-restantes × 1,5) para um nó caro não estrangular o grafo (run inicial, take6).

## 4. Decisões de fechamento

- Os checkpoints originais não entregues (paralelismo/fanout, gates por nível de risco, fatos/ack/docs geradas) foram transportados para esta spec (P0.4, P0.5, P0.6) e encerram a campanha por supersessão — registrado no journal.
- Esta retrospectiva cumpre a exigência (agora mecânica) de `campaign close`.
