---
title: "Interceptação pré-ferramenta e fechamento do backlog"
version: 0.8.1
status: ready
date: 2026-09-12
owner: Felipe Broering
baseline: feliperun/skills @ 33a4772
campaign_id: interception-and-backlog-20260912
amends: "PRD 0.8.0 (interception-and-backlog-20260911)"
supersedes_baseline: "7c1c60a"
---

# Interceptação pré-ferramenta e fechamento do backlog

Esta spec implementa o PRD 0.8.0. A diferença entre as duas é uma remedição: o
PRD foi escrito contra `7c1c60a` e o HEAD hoje é `33a4772`, com dezessete
commits de reorganização entre os dois. **Cinco itens do PRD já estão
fechados, e o bloco central (C6) já tem o mecanismo pronto** — só falta o
conteúdo da política. Executar o PRD como escrito refaria trabalho feito, que é
exatamente o que o pedido de gastar o mínimo proíbe.

## 0. Estado remedido

Medido em `33a4772`, não herdado.

| Indicador | PRD (7c1c60a) | Hoje (33a4772) | Meta | Situação |
|---|---|---|---|---|
| Maior módulo de `src/` | 1.640 | **788** (`harnesses/exec-jsonl`) | < 1.200 | **fechado** |
| Módulos `src/` > 1.200 linhas | 4 | **0** | 0 | **fechado** |
| Golden set | 14 | **26** | ≥ 20 | **fechado** |
| Ponteiros de raiz duplicando `AGENTS.md` | 4 | **0** (já são symlinks) | 0 | **fechado** |
| Guarda de runtime de fixture | ausente | **presente e verde** | presente | **fechado** (C8.5a) |
| `SKILL.md` | 5.993 B | 5.993 B | < 4.000 B | aberto |
| Preâmbulo do control session | 35.417 B | 35.417 B | < 24.000 B | aberto, **mas ver §1** |
| `catch {}` vazios em `src/` | — | **28** (teto em CI: 32) | 0 | aberto |
| Interceptação pré-ferramenta | ausente | **mecanismo presente**, política ausente | presente | aberto, **ver §2** |
| Delegação de leitura em massa | ausente | ausente | presente | aberto |
| Mutation testing | ausente | ausente | presente | aberto |
| `status` derivado | ausente | ausente | presente | aberto |
| D01–D16 | verdes | verdes | verdes | mantido |
| Harnesses | 7 | 7, **todos disponíveis** | 7 + capacidade | ver §2 |

Fechado desde o PRD, além da tabela: teto de 800 linhas por arquivo (mais
estrito que os 1.200 pedidos) agora **verificado em teste**, junto com ausência
de ciclo de import, de corpo duplicado, de nome exportado em dois módulos e de
barrel — `test/repo/source-shape.test.mjs`.

## 1. O que a análise de C8.1 deixou

C8.1 saiu desta campanha (§4): S5.4 da spec do assento de operador faz a dieta
uma vez, com a estrutura de artigos final. Duas medições da análise continuam
valendo e vão para lá:

**C8.1c já está satisfeito por construção.** `src/contract/task-packet.mjs`
nunca lê `SKILL.md` nem `references/` — o prompt do worker é renderizado só do
packet. Nenhum worker carrega `contract.md` hoje.

**C8.1a já existe.** `test/docs/docs-diet.test.mjs` já falha acima de 6.144 /
20.480 / 10.240 B. O que falta não é criar o gate, é baixar o teto.

**E o número de 35.417 B não é o preâmbulo de ninguém.** É `SKILL.md` +
`contract.md` + `operations.md`, e nenhuma sessão carrega os três: o contrato
só é lido por quem autora contrato. Somar bytes de arquivo não mede contexto —
o alvo de S5.4 tem de ser o caminho feliz medido com o tokenizer do provedor.
`AGENTS.md` (5.282 B, novo em 2026-09-12) entra nessa conta, porque esse é
carregado sempre.

## 2. C6 já tem o mecanismo; falta a política

`src/host/tool-policy-hook.mjs` é, hoje:

- um hook `PreToolUse`/`PostToolUse` do repositório, com decisões **puras e
  exportadas** — que é a forma que o C6.1 pede para `policy.mjs`;
- instalado **por invocação** via `--settings` inline pelo adaptador `claude`,
  sem escrever arquivo nenhum no worktree — melhor que o C6.3 planeja, e faz o
  C6.8 (remoção na selagem) ficar vazio: não há o que remover;
- gated por **capacidade declarada**: `workerToolPolicy()` devolve `undefined`
  quando `runtime.capabilities.toolPolicy !== true`, e só `claude` declara
  `true`. **O ADR-0030 já está implementado**, sob o nome `toolPolicy`.

Consequência de desenho: o `preToolInterception: boolean` que o ADR-0030 propõe
seria **uma segunda flag para o mesmo mecanismo**. Duas capacidades para uma
coisa é a categoria de defeito que o `AGENTS.md` deste repo agora proíbe por
teste. A spec estende `toolPolicy`, não duplica.

O que falta é o conteúdo. Hoje `ToolPolicy` é
`{foregroundOnly, maxToolOutputBytes}`. Precisa de `{writeFiles, maxReadLines}`
e das três decisões novas — e o packet do nó precisa chegar em
`workerToolPolicy`, que hoje só recebe o runtime.

C6 revisado:

| id | item | prova |
|---|---|---|
| c6.1 | `ToolPolicy` carrega `writeFiles` e `maxReadLines`; decisão segue pura | `command: npm test -- --test-name-pattern="tool policy is pure"` |
| c6.2 | escrita fora de `writeFiles` é negada na chamada, citando os paths declarados | `command: npm test -- --test-name-pattern="tool policy write scope"` |
| c6.3 | leitura acima do limiar é negada citando linhas medidas e limiar | `command: npm test -- --test-name-pattern="tool policy read threshold"` |
| c6.4 | leitura com `offset` ou `limit` passa | `command: npm test -- --test-name-pattern="tool policy targeted read"` |
| c6.5 | arquivo abaixo do limiar passa | `command: npm test -- --test-name-pattern="tool policy small file"` |
| c6.6 | `cat`/`head`/`tail`/`less`/`more` com pipe ou redirecionamento passam | `command: npm test -- --test-name-pattern="tool policy bash passthrough"` |
| c6.7 | harness sem `toolPolicy` roda sem hook e sem erro (já vale; fixar em teste) | `command: npm test -- --test-name-pattern="tool policy optional capability"` |
| c6.8 | path inexistente falha ruidosamente, nunca vira negação vazia | `command: npm test -- --test-name-pattern="tool policy missing path"` |

`c6.9` do PRD (remoção na selagem) sai: não há arquivo instalado. Registrar o
motivo no comentário do módulo em vez de inventar teardown.

## 3. C7 — delegação de leitura em massa

Único bloco inteiramente novo. Segue o PRD, com dois ajustes medidos:

- o harness de delegação sai do catálogo declarado, ordenado por custo: hoje
  `agy` (`gemini-3.8-flash-low`) é o mais barato com janela real. `runtime-discovery`
  já compõe por `tier`/`costRank`; a delegação reusa isso, não inventa tabela.
- a skill de 500 B mora em `src/interception/`? Não: mora onde o resto das
  skills mora. O alvo de bytes fica, o caminho muda.

DoD como no PRD (c7.1–c7.7), com `c7.6` medindo contra o `docs-diet` existente.

## 4. C8 revisado

| item | situação | ação |
|---|---|---|
| C8.1 | **removido** | substituído por S5.4 de `TECH-SPEC-2026-09-12-operator-seat.md`: a dieta acontece uma vez, com a estrutura de artigos final. Cortar para 4 KB agora e para 1 KB depois é compute pago duas vezes |
| C8.2 | **fechado** | nada; o teto agora é 800 e está verificado |
| C8.3 | **fechado** | nada; 26 ≥ 20 |
| C8.4 | aberto | como no PRD |
| C8.5 | parcial (a fechado) | c8.5b e c8.5c |
| C8.6 | aberto | 28 → 0, descendo o teto do ratchet a cada nó |
| C8.7 | **fechado** | nada; já são symlinks |
| C8.8 | **removido** | substituído por S5.1 (ADR-0037, estado por diretório): derivar `status` na leitura e depois eliminá-lo é escrever código para apagar |

## 5. Fases

Cinco fases do PRD viram três, porque duas ficaram sem conteúdo.

| Fase | Conteúdo | Worker | Juiz |
|---|---|---|---|
| P1 | C8.5b/c, C8.6 (`catch {}` 28 → 0) | `dsh-deepseek` | `codex-gpt` |
| P2 | C6 (política de interceptação) | `claude-sonnet` | `codex-gpt` |
| P3 | C7 (delegação), C8.4 | `zcode-glm` + `dsh-deepseek` | `claude-sonnet` |

Roteamento por custo, não por preferência:

- **`dsh-deepseek`** (`deepseek-flash`): worker padrão. Mais barato e não
  consome a franquia do ChatGPT nem a da Anthropic.
- **`zcode-glm`** (`glm-5.3-flash`): segunda faixa barata, para rodar em
  paralelo com o dsh sem competir por franquia.
- **`claude-sonnet`**: worker só na P2, onde o nó mexe no engine e no hook —
  o único lugar onde errar custa mais que o modelo.
- **`codex-gpt`** (`gpt-5.6`, effort medium): juiz para worker deepseek/zhipu.
  Cross-vendor por construção.
- **`agy-gemini`**: não é worker nem juiz; é o **alvo da delegação** do C7.
- **`replay`**: os evals. Zero token.

## 6. Regras de execução

As sete do PRD valem sem alteração. Duas adições medidas hoje:

8. Nenhum nó desta campanha tem redução de linhas como objetivo, **e o teto de
   800 linhas é verificado por teste** — um nó que estoura o teto falha na
   verificação, não no juiz.
9. Antes de declarar um item aberto, medir. Cinco dos treze itens do PRD já
   estavam fechados quando esta spec foi escrita, e o único jeito de saber foi
   rodar os comandos.

## 7. Critério de sucesso

| Métrica | Baseline (33a4772) | Alvo |
|---|---|---|
| `costPerClosedCheckpoint` | `evals/baseline.json` | não regride |
| `catch {}` em `src/` | 28 | 0 |
| Módulos > 800 linhas | 0 | 0 (manter) |
| Golden set | 26 | 30 ou mais |
| D01–D16 | verdes | verdes |
| Tokens de leitura por nó com `toolPolicy` | medir na P2 | queda medida na P3 |

A campanha fecha com retrospectiva registrando delta contra `evals/baseline.json`.
Sem delta medido, a retrospectiva descreve intenção, não resultado.
