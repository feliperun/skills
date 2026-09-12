---
title: "Retrospectiva: interceptação pré-ferramenta e fechamento do backlog"
campaign_id: interception-and-backlog-20260912
date: 2026-09-12
spec: docs/TECH-SPEC-2026-09-12-interception.md
baseline: evals/baseline.json (intent-factory-measurement-20260910)
range: 5044c35..66f46c9
---

# Retrospectiva — `interception-and-backlog-20260912`

Três fases, seis nós, cinco nós fechados e um bloqueado. 1,4 h de relógio de
nó. Toda afirmação aqui saiu de um comando; onde não saiu, está dito.

## 1. Delta medido contra `evals/baseline.json`

Os dois lados desta tabela foram recalculados com a mesma definição, depois
de duas correções que a própria campanha provocou (§1.1).

| Indicador | Antes | Depois | Melhora é |
|---|---|---|---|
| `costPerClosedCheckpoint` | 5,5908 (n=9) | **1,2295** (n=3) | ↓ |
| `wallClockPerClosedCheckpoint` | 1688,2 s (n=9) | **1008,5 s** (n=5) | ↓ |
| `revisionsPerDone` | 0,3333 (n=9) | **0,2** (n=5) | ↓ |
| `firstPassGateRate` | 3/9 | **3/6** | ↑ |
| `blockedContextRate` | 0 (n=9) | **0,1667** (n=6) | ↓ — **regrediu** |
| `judgeInvocationRate` | 1 | 1 | ↑ |
| `protocolFailureRate` | 0 (n=23) | 0 (n=19) | ↓ |
| `providerFailoverRate` | 0 | 0 | ↓ |

O `n=3` do custo é a informação nova: a campanha fechou seis checkpoints e só
três tiveram custo reportado por um provedor. `usageCostUsd` da campanha:
**3,69 · 15 unknown**.

`blockedContextRate` regrediu por um nó, `bulk-read`, e as duas causas estão
na §3.

### 1.1 Duas correções na própria medição

**`costPerClosedCheckpoint` premiava o silêncio.** O numerador somava só
registros com `costProvenance != unknown`; o denominador era *todo* checkpoint
fechado. `dsh`, `zcode` e `codex` com conta ChatGPT não reportam custo, então
qualquer movimento de trabalho na direção deles fazia o indicador cair sem
economia nenhuma provada. Sob a definição velha esta campanha reportaria
**0,7377**, que era a conta de uma fase dividida por três. Agora divide pelos
checkpoints efetivamente medidos, e publica esse número como `count`.

**O baseline tinha sido tirado antes da própria campanha terminar.** Os cinco
run dirs de `intent-factory-measurement-20260910` guardam nove checkpoints
fechados; o arquivo gravava sete, e não trazia o nó `golden-set`. Toda
comparação feita contra ele desde 2026-09-10 media contra uma campanha
parcial. Recalculado dos mesmos cinco run dirs, com o motivo no
`provenance.note`.

## 2. O que fechou

| Item | Como |
|---|---|
| C6 — política de interceptação | `ToolPolicy` carrega escopo de escrita, workspace e limiar de leitura; três decisões puras em `host/tool-policy-decisions.mjs`; oito testes nomeados |
| C7 — delegação de leitura em massa | `engine/bulk-read.mjs`, skill de 448 B, roteamento por `DISCOVERY_RUNTIME_DEFINITIONS` |
| C8.4 — mutation testing | entrada `mutation` com limiar, seis operadores, oito mutantes determinísticos, escopada aos `writeFiles` |
| C8.5b — suíte sem CLI de provedor | medido, não implementado: com os cinco CLIs mascarados como `exit 127` a suíte passa |
| C8.5c — tolerância de relógio | dois gates: limite superior em duração afirmado em zero, espera bloqueante com catraca em 1 |
| C8.6 — `catch {}` mudo | 28 → 0, catraca afirmada em igualdade |

C8.1 e C8.8 saíram para `TECH-SPEC-2026-09-12-operator-seat.md` (S5.4 e S5.1),
como a spec decidiu: cortar `SKILL.md` duas vezes é compute pago duas vezes.

## 3. O que quebrou, e o que cada quebra ensinou

**`bulk-read` bloqueou por erro de autoria do packet, não do worker.** O
packet declarou `skills/mine/bulk-read/SKILL.md` em `writeFiles` mas não
`test/installer.test.mjs`, que muda *obrigatoriamente* quando uma terceira
skill entra no catálogo — o teste afirma `2 installed`. O worker fez a coisa
certa; o gate de escopo pegou certo e bloqueou certo. **A máquina funcionou
sobre um contrato incompleto.** Regra: `writeFiles` inclui todo arquivo que a
mudança *obriga* a mudar, não só os que ela pretende mudar.

**O juiz não estava indisponível; o envelope é que recusou um `pass` limpo.**
`JUDGE_SCHEMA` exigia `findings` mesmo sem nada a reportar. O juiz respondeu
`pass`/`none` confirmando os três itens, o `StructuredOutput` foi recusado
com *"must have required property findings"*, o CLI saiu 1, e `review.mjs`
gravou `judge_unavailable`. O mesmo modelo cumpriu no nó irmão: **falhava às
vezes**. Corrigido — ausente e `[]` são a mesma afirmação.

**O juiz aprovou um defeito que eu peguei na leitura.** `writeScopeDecision`
só negava se o arquivo alvo já existisse. A regra "caminho inexistente nunca
nega" vale para as duas decisões de *leitura* (não dá para medir o que não
existe), não para escrita: pertencer ao escopo é fato sobre o caminho. O
efeito era a decisão disparar só em sobrescrita — criar arquivo novo fora do
escopo, a violação comum, passava sempre. O próprio teste se contradizia em
duas asserções seguidas.

**`build-golden.mjs` apagou 19 das 26 tarefas golden porque rodei com uma
flag que ele não tem.** Ele ignora `argv` e abre com `rmSync` da raiz. Quem
seguir o docstring dele perde tudo que o pool curado não produz mais.
Restaurado do git. E a descoberta de commits estava morta em silêncio desde a
reorganização: casava com `src/` e `test/`, prefixos que deixaram de existir
quando a skill ganhou diretório próprio. Esse era o mecanismo do C8.3.

**Havia uma segunda catraca de `catch {}` em `test/ci-policy.test.mjs`**, com
`count <= 32`, sobre uma varredura própria. Como o gate real afirma igualdade
em zero, a cópia nunca poderia falhar. Catraca que só trava num sentido é
pior que nenhuma.

## 4. Roteamento: o que o custo disse

| Fase | Worker | Juiz | Primeira passagem | Custo reportado |
|---|---|---|---|---|
| P1 | `dsh-deepseek` | `codex-gpt` | 1/2 | — (nenhum reporta) |
| P2 | `claude-sonnet` | `codex-gpt` | 1/2 | **US$ 3,42** |
| P3 | `zcode-glm`, `dsh-deepseek` | `claude-sonnet` | 1/2 | US$ 0,27 |

A aposta da spec — `claude-sonnet` como worker só onde errar custa mais que o
modelo — **não se pagou nesta amostra**: a P2 custou 12× a P3 e teve a mesma
taxa de primeira passagem, e foi justamente o nó `claude-sonnet` da P2 que
entregou o defeito de escopo de escrita. Amostra de dois nós por fase não
decide nada sozinha, mas a hipótese oposta (worker barato, juiz forte) é a
que está com os números do lado dela.

`blockingJudgeFirstPassRate`: `codex-gpt` 0,67 · `claude-sonnet` 0,5 ·
`zcode-glm` 0 (um nó, e o zero é o bloqueio de escopo, não julgamento).

## 5. Aberto

Nenhum destes é defeito que esta campanha deixou quebrado. Um foi consertado
na raiz, um é propriedade da ferramenta, e um é dependência declarada da
campanha seguinte.

1. **`judge_unavailable` cobre duas falhas diferentes** — "não havia juiz" e
   "o juiz respondeu e o envelope não validou" — e o operador lê *"Claude
   exited with code 1"*, que aponta para disponibilidade de provedor, onde a
   resposta não está. **Não separado, e de propósito:** o remédio é o mesmo
   nos dois casos — bloquear com o trabalho preservado para um retry
   re-julgar em lugar — e um segundo código fragmentaria `retry.mjs` sem
   ganho de comportamento. O que enganava era a mensagem, e a causa dela (o
   schema exigindo `findings`) está corrigida, então não reincide. Fica como
   observabilidade.
2. **`fixtures.bundle` está em 4,0 MB**, contra 1,66 MB antes de ganhar uma
   tarefa de commit recente. É inerente ao `git bundle`: ele carrega o
   histórico alcançável, não só a árvore que a tarefa restaura. Mitigar
   exigiria trocar o formato — arquivo da árvore em vez de bundle — que é
   redesenho, não conserto.
3. **Nenhum worker chama `bulk-read`, e isso é do desenho.** O packet é
   fechado: `contract/task-packet.mjs` renderiza o prompt só do packet, então
   um worker nunca descobre a skill. Pô-la no prompt de todo nó adiciona
   preâmbulo a todo nó, que é exatamente o que a S5.4 de
   `TECH-SPEC-2026-09-12-operator-seat.md` existe para cortar. O lugar de
   resolver é lá, com a estrutura de artigos em camadas. Consequência a
   aceitar por ora: a queda de tokens de leitura que a §7 da spec queria
   medir na P3 continua sem medição, porque a ferramenta ainda não foi usada.

## 6. Estado final

`606 testes · 604 pass · 0 fail · 2 skipped` · `tsc` limpo · nove gates de
forma verdes · 16/16 casos determinísticos · 27 tarefas golden, todas
restaurando.
