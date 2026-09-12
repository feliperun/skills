---
title: "Assento do operador, acesso remoto e lições do SwarmForge"
version: 0.9.1
status: active
date: 2026-09-12
owner: Felipe Broering
baseline: feliperun/skills @ 33a4772+
campaign_id: operator-seat-and-remote-20260912
implements: "PRD 0.9.0 (operator-seat-and-remote-20260912)"
depends_on: "interception-and-backlog-20260912 (roda primeiro)"
supersedes: ["C8.8 de 0.8.1 (status derivado)", "C8.1 de 0.8.1 (dieta de preâmbulo)"]
---

# Assento do operador, acesso remoto e lições do SwarmForge

Enfileirada atrás de `interception-and-backlog-20260912`. Esta seção 0 é a
única diferença material contra o PRD 0.9.0: duas sobreposições entre as
campanhas que, se ignoradas, fazem a primeira pagar por trabalho que a segunda
joga fora.

## 0. Sobreposição com a campanha anterior

O PRD 0.9.0 diz, corretamente, que **ADR-0037 substitui C8.8** e que **S5.4
resolve C8.1**. Como a campanha anterior ainda não rodou, a consequência é
executável e não teórica:

| item de 0.8.1 | destino | ação |
|---|---|---|
| C8.8 (`status` derivado na leitura) | substituído por S5.1 (estado por diretório) | **remover de 0.8.1**, não implementar duas vezes |
| C8.1 (`SKILL.md` < 4.000 B) | substituído por S5.4 (`SKILL.md` < 1 KiB, artigos reservados) | **remover de 0.8.1**; a dieta acontece uma vez, com a estrutura final |

Implementar C8.8 e depois S5.1 significa escrever a derivação de `status` e
apagá-la na campanha seguinte. Implementar C8.1 e depois S5.4 significa cortar
`SKILL.md` para 4 KB e cortar de novo para 1 KB com um layout diferente. Ambos
são compute pago duas vezes.

Fica em 0.8.1, do bloco C8: C8.4 (mutação), C8.5b/c, C8.6 (`catch {}`).

## 1. Estado medido

Medido em `33a4772+` (árvore de trabalho, pós-`/simplify`).

| Indicador | Hoje | Alvo | Nota |
|---|---|---|---|
| `src/web/server.mjs` | 486 linhas | + rotas de S3.2 | já tem `/api/snapshot` e `/api/stream`; S3 estende |
| `SKILL.md` | 5.993 B | < 1.024 B | S5.4a. Alvo 5,9x mais agressivo que o de 0.8.1 |
| `references/` | 2 arquivos, 29.424 B | 6 artigos, 4 reservados | S5.4 |
| `status` como campo gravado | sim, em `contract/snapshot.mjs` | não existe | S5.1 |
| `changedFiles` no resultado do worker | aceito e exigido | derivado | S5.2a — **quebra o protocolo do worker** |
| `tmux` | **instalado** (`/opt/homebrew/bin/tmux`) | opcional | S1 pode ser testado de verdade aqui |
| `tailscale` | **instalado** (`/usr/local/bin/tailscale`) | obrigatório para S3 | S3.3 pode ser testado de verdade |
| Assento de operador | inexistente | `src/seat/` | S1 |
| Brief de operador | inexistente | 4 KiB, determinístico | S2 |
| Casos de eval | D01–D16 | + D17–D23 | 23 |

Duas dessas linhas merecem atenção antes de virarem nó:

**`changedFiles` é breaking.** Hoje `contract/worker-result.mjs` exige
`changedFiles` no objeto que todo worker devolve, e o prompt renderizado pede
por ele. S5.2a passa a rejeitá-lo. Isso invalida todo packet e toda gravação
existente sob `.runs/`, e muda o texto do prompt de worker — que por sua vez
muda o preâmbulo que S5.4 está medindo. Ordem correta: **S5.2 antes de S5.4**,
não depois.

**`SKILL.md` a 1 KiB é a restrição mais dura da campanha.** 5.993 → 1.024 é
tirar 83%. Só é possível porque S5.4 move o conteúdo para artigos, não porque
ele encolhe. Se o resultado for um roteador de 1 KB apontando para 30 KB de
artigos que toda sessão carrega, o número melhorou e o custo não. **A métrica
de aceite tem de ser o preâmbulo do caminho feliz medido com o tokenizer do
provedor, não a soma dos bytes dos arquivos** — que é o mesmo erro que a §1 da
spec de 0.8.1 já identificou.

## 2. Ordem de fases revisada

O PRD propõe S-P1..S-P5. Duas trocas, ambas por dependência medida acima:

| Fase | Conteúdo | Worker | Juiz | Mudança contra o PRD |
|---|---|---|---|---|
| S-P1 | S2 (brief) + S5.5 (lossy) | `dsh-deepseek` | `codex-gpt` | — |
| S-P2 | S1 (assento, tmux) | `dsh-deepseek` | `codex-gpt` | **worker barato**, ver §2.1 |
| S-P3 | S5.2 (campo derivável) + S5.1 (estado por diretório) | `claude-sonnet` | `codex-gpt` | **antecipado**: muda o protocolo do worker, e S5.4 mede o prompt que ele produz |
| S-P4 | S3 (daemon, Tailscale) | `zcode-glm` | `claude-sonnet` | — |
| S-P5 | S4 (Hermes) + S5.3 (dono por campo) | `dsh-deepseek` | `codex-gpt` | — |
| S-P6 | S5.4 (constituição em camadas) | `zcode-glm` | `codex-gpt` | **worker barato**; por último, com D01–D23 verdes |

### 2.1 Por que `claude-sonnet` sai de worker em duas fases

`interception-and-backlog-20260912` mediu as três combinações. A fase com
worker Claude custou **US$ 3,42** contra **US$ 0,27** da fase com worker barato
— 12× — e as duas tiveram a **mesma taxa de primeira passagem** (1/2). Pior: o
único defeito que um juiz deixou passar naquela campanha saiu justamente do nó
`claude-sonnet` (a decisão de escopo de escrita que só disparava em
sobrescrita). A hipótese "worker caro onde errar custa mais que o modelo" não
tem número a favor; a hipótese oposta tem.

`claude-sonnet` fica como worker só na **S-P3**, que é a única fase que quebra
o protocolo do worker e invalida toda gravação existente sob `.runs/`.

### 2.2 Três restrições de capacidade, medidas

| Restrição | Consequência |
|---|---|
| `zcode` declara `structuredOutput: false` — não tem flag de schema | **nunca é juiz.** O veredito viajaria no texto do prompt, com validação só no `parseJudge`. Worker, sim |
| só `claude` declara `toolPolicy: true` | a política de interceptação do C6 **só morde em worker Claude**. A queda de tokens de leitura que a campanha anterior não mediu só é mensurável num nó Claude |
| só `claude` reporta custo | os outros quatro entram como `unknown`. Não impede usá-los; obriga a ler o `count` de `costPerClosedCheckpoint`, que desde 2026-09-12 conta só checkpoints medidos |

`codex` roda `gpt-5.6-sol`: `gpt-5.6` é recusado por conta ChatGPT com
`400 invalid_request_error` (codex-cli 0.154.0). `agy-gemini` segue sem uso
como worker ou juiz — é o vendor `google`, disponível como juiz cross-vendor
para qualquer um dos outros quatro. `replay` nos evals, zero token.

## 3. O que esta spec não muda

ADRs 0032–0037, S1–S5 e os DoDs do PRD valem como escritos, com três notas:

- **S3.1**: `web/server.mjs` está em 486 linhas e o teto deste repo é 800. As
  rotas de S3.2 mais a fronteira de S3.3 não cabem no mesmo arquivo. O daemon
  sai como `src/web/api.mjs` (rotas) e `src/web/boundary.mjs` (bind, token),
  com `server.mjs` mantendo o agregador e o stream.
- **S5.4**: os quatro nomes reservados precisam de um teste que falhe quando um
  contrato os declara (s5.4b). Isso é uma regra de `contract/`, não de docs, e
  o gate mora em `test/contract/`.
- **S1.4**: `tmux` está instalado nesta máquina, então "degrada sem tmux"
  precisa ser testado com o binário mascarado do `PATH`, como
  `test/harnesses/` já faz com os CLIs de provedor. Um teste que passa porque a
  ferramenta existe não prova degradação.

## 4. Critério de sucesso

Os cinco cenários do PRD §11, mais um que a máquina permite verificar de fato:

| Cenário | Aceite |
|---|---|
| Crédito acaba no meio da campanha | `seat switch --harness codex`, assento novo lê o brief, zero retrabalho |
| Saio de casa | pelo celular via Tailscale, cinco números e resposta a decisão |
| Mac velho | SSH, `tmux attach`, opera igual |
| Campanha precisa de mim | Hermes no WhatsApp, resposta pelo celular |
| Nada precisa de mim | nenhuma notificação, nenhum token gasto |
| **Sem tmux no PATH** | toda campanha funciona; só reanexar se perde, e `seat` diz isso |
