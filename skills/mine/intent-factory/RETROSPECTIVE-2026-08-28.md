# Retrospectiva intent-factory — campanhas `clinical-apps-poc` e `edge-poc` (poc-grpc-desktop, 2026-08-27/28)

Objetivo: o que mudar em `scripts/runner.mjs` + skill para ficar **mais robusto, mais barato em tokens e bem mais rápido**.
Evidência: `.runs/*/logs/*.jsonl` (campo `result.usage`), `.runs/*/events.jsonl`, `.runs/*/nodes/*.json` do repo poc-grpc-desktop.

## 1. Evidência

### 1.1 Custo/tempo por invocação (extraído dos jsonl)

| Nó (worker) | turnos | min | cache-read tokens | output | US$ |
|---|---|---|---|---|---|
| edge-poc e1a-remove-rename | **509** | 64 | **204,7 M** | 261 k | **46,42** |
| edge-poc e1b-cloud-backend (1) | 278 | 48 | 87,0 M | 173 k | 21,06 |
| edge-poc e1b (2, reinvocação só p/ JSON) | 1 | 0,4 | 0,02 M | 2 k | 1,97 |
| clinical f1b-gateway-and-ci | 96 | 21 | 41,9 M | 80 k | 11,30 |
| clinical f4-beliva (2) | 82 | 24 | 31,0 M | 102 k | 9,06 |
| clinical f1a-device-services | 109 | 27 | 21,3 M | 98 k | 6,55 |
| local-first t4-gateway-storage-proxy | 85 | 11 | 10,4 M | 62 k | 3,40 |

Juízes (Opus): 4–9 min e US$ 1,9–3,9 por nó (f1a 6,3 min/3,44; f4 4,3 min/3,90; f5 5,8 min/2,39).

Comparação — mesma tarde, **agentes diretos** (Sonnet, sem juiz, sem gate de escopo, eu verificando):
`/explain/` 169 k tokens / 13 min; ponte cloud+login 542 k / 45 min; docs+ADR 359 k / 22 min — **em paralelo**, 45 min de relógio para o que a campanha estimava em 3 nós sequenciais (~2 h + 3 juízes).

Leitura: o custo é dominado por **cache-read**, i.e. o transcript do worker crescendo por centenas de turnos (E1a: ~400 k tokens de contexto por turno no fim). Output é <3 % do custo.

### 1.2 Falhas que custaram tempo humano/agente (hoje)

| Falha | Causa | Custo |
|---|---|---|
| `unexpected_write` em E1a (`Cargo.lock`, `.sentrux/baseline.json`) | writeRoots só aceita diretórios; arquivos raiz gerados (lockfiles, baseline) não são cobríveis; o packet pediu `sentrux gate --save` | nó marcado *failed* com trabalho verificado e correto no disco; 1 rodada de triagem manual |
| `unexpected_write` em F1a (README.md raiz, tests/integration) | idem | rerun |
| `snapshot_ignore_changed` | humano fez `git switch` durante o run; snapshot atrelado ao estado do índice | rerun |
| "worker result did not match the structured result protocol" ×3 (F1b, F2, E1b) | worker terminou em prosa, ou ficou esperando Playwright em background e o turno acabou | reinvocação completa (worker+juiz) ≈ US$ 2–5 e 10–20 min cada |
| controller detached morreu silencioso (429 session-limit; `campaign supervise` cedo tomou o lease) | sem supervisor/heartbeat visível; `status` não mostra a causa | ~30 min sem progresso até perceber |
| `verification.timeoutSec ≤ 600` | `cargo test --workspace` frio + Playwright passam de 10 min | packet inválido até ajustar |
| Sequencial (`maxParallel` 1) | web/rust/docs em nós encadeados mesmo com writeRoots disjuntos | E4'+bridge+docs: 2 h estimadas vs 45 min em paralelo |
| Node 26 no shell (`--experimental-transform-types` removido) | ambiente do host mudou no meio; worker herdou | S13 vermelho; diagnosticado como "pre-existing" pelo worker |

## 2. Diagnóstico (onde vai o tempo e o dinheiro)

1. **Transcript sem compactação**: 1 sessão por nó, 100–500 turnos, cada turno relê tudo. É o item nº 1 de custo (E1a: US$ 46) e também de latência (turnos de 400 k tokens são lentos).
2. **Verificação dentro do worker é cara e repetida**: o worker roda `cargo test --workspace`/Playwright inteiros várias vezes por conta própria (3–5 min cada). O gate determinístico depois roda de novo.
3. **Juiz Opus em todo nó**: 4–9 min e US$ 2–4, mesmo em nós de docs/rename. Em 2 dias, juízes ≈ 20 % do relógio e ~25 % do custo dos nós pequenos.
4. **Serialização por padrão**: a maior perda de relógio. Nós com writeRoots disjuntos poderiam rodar juntos.
5. **Gate de escopo rígido demais** para o que ele protege: falha *terminal* por arquivo raiz gerado, descartando trabalho já verificado.
6. **Protocolo do resultado frágil**: depende da última mensagem ser JSON puro; não há canal alternativo (arquivo), e a recuperação reinvoca o worker inteiro.

## 3. Propostas (prioridade × ganho)

### P0 — velocidade e custo (ganho esperado: 2–3× no relógio, 3–5× no custo)

**P0.1 Rotação/compactação automática do worker.** O runner já tem `continuation` com modos `fresh|reuse|rotate` (runner.mjs ~L962–1000). Tornar `rotate` automático por gatilho: `turns ≥ 80` **ou** `cache_read_tokens/turno ≥ 120 k`. Na rotação: o worker escreve `HANDOFF.md` do nó (feito, pendente, comandos que passam/falham, arquivos tocados) e a nova sessão recebe só packet + HANDOFF + `git status --short`. Alternativa mais simples: `--max-turns` por invocação + reuse com prompt "continue". Alvo: contexto por turno < 150 k → E1a cairia de US$ 46 para ~US$ 10–12 e de 64 para ~35 min.

**P0.2 Paralelismo por disjunção de writeRoots.** `maxParallel` default 3; antes de agendar, o runner checa interseção de `writeRoots` (já os conhece) e roda em paralelo tudo que for disjunto e sem `dependsOn`. Acrescentar ao contrato `sharedResources: ["e2e-ports", "cargo-target"]` — nós que declaram o mesmo recurso ficam mutuamente exclusivos (Playwright em 515xx, `pnpm build` no mesmo dist). Isso reproduz o fan-out manual de hoje sem perder o registro.

**P0.3 Juiz condicional e mais barato.** `gate.mode`: `"deterministic"` (só comandos), `"judge-on-risk"` (default) e `"always"`. Em `judge-on-risk`, o Opus só entra quando: verificação determinística falhou 1×, o nó toca roots marcados `risk: high` (auth, security, proto), ou é o último nó da fase. Nos demais, um juiz **Haiku/Sonnet** com checklist fixo (escopo, testes adicionados, copy/idioma, sentrux) — < 1 min, < US$ 0,3. Passar ao juiz `git diff --stat` + diffs sob demanda (tool), não o diff inteiro no prompt.

**P0.4 Verificação em dois níveis.** Packet ganha `verification.fast` (ex.: `cargo test -p edge-gateway`, `playwright test specs/e2e-19*`) que o worker é instruído a usar no loop, e `verification.full` (suite inteira) que **só o gate determinístico** executa uma vez. Instruir explicitamente: "não rode a suíte completa; o runner roda". Ganho: 10–20 min por nó Rust/web.

**P0.5 Pré-aquecimento único por run.** `contract.preflight: ["cargo build --workspace", "pnpm install"]` executado pelo controller antes do 1º worker (e após rotações não). Hoje cada worker paga o primeiro build frio.

### P0 — robustez

**P0.6 Resultado por arquivo, não por última mensagem.** O worker escreve `.runs/<run>/nodes/<id>.result.json` (o prompt manda gravar via Write como último passo) e a mensagem final vira redundante. Se o arquivo faltar: continuação **de 1 turno** na mesma sessão (`--max-turns 1`, prompt "escreva o result.json agora") em vez de reinvocar worker + juiz (custou US$ 2–5 e 10–20 min cada uma das 3 vezes). Aceitar também JSON dentro de fences/prosa (o `extractJson` existe — E1b falhou porque não havia JSON nenhum).

**P0.7 Proibir background no worker por mecanismo, não por texto.** Hook `PreToolUse` na config do worker que nega `Bash` com `run_in_background: true` e `Monitor`/`TaskOutput`; a mensagem de negação já ensina "rode em foreground". 2 das 3 falhas de protocolo vieram de "vou esperar o Playwright em background".

**P0.8 Gate de escopo com arquivos e severidade.** `writeRoots` aceita arquivos (`README.md`, `Cargo.lock`) e o runner adiciona automaticamente os lockfiles/baselines derivados dos manifestos tocados (`Cargo.toml→Cargo.lock`, `package.json→pnpm-lock.yaml`, `.sentrux/rules.toml→baseline.json`). `unexpected_write` passa a ser **finding para o juiz** (com paths) quando a verificação determinística passou; só é terminal quando a escrita é fora de qualquer root **e** o nó falhou na verificação. Nunca descartar trabalho verde.

**P0.9 Snapshot de ignore resiliente.** Chavear `snapshot_ignore_changed` no conteúdo de `.gitignore`/`info/exclude`, não no índice; `git switch` do humano vira aviso no `status`, não falha do nó (o controller já usa `git ls-files` — comparar listas, não HEAD).

**P0.10 Controller supervisionado.** `run --detach` sobe via `supervisor.mjs` com heartbeat e restart (backoff) em `session_limit/429/ECONNRESET`; `status` mostra `lastError`, `elapsed` por nó e `ETA` (média dos nós anteriores da fase). Adicionar `runner pause <run>` (para entre nós, sem cancelar) — hoje precisei de um watcher externo para isso.

**P0.11 Limites realistas.** `verification.timeoutSec` até 1800; timeout por comando com `killSignal` e log parcial salvo.

### P1 — economia de tokens

**P1.1 Truncar saída de ferramentas.** Hook `PostToolUse` no worker: saída de Bash > 8 KB é cortada (head+tail) com nota "saída truncada; use grep/tail". Workers de hoje faziam `cargo build 2>&1 | tail -200` e leram logs enormes de Playwright.

**P1.2 Packet enxuto + `readFiles` como ponteiros.** Já é pequeno (6,5 KB). Manter; adicionar `contextBudget` por nó (ex.: 150 k) que dispara P0.1.

**P1.3 Roteamento de modelo por tipo de nó.** `docs`/`rename`/`copy` → Haiku (juiz Haiku); `impl` → Sonnet; `security`/`proto` → Sonnet + juiz Opus. Hoje tudo Sonnet + Opus.

**P1.4 Não rejulgar o que não mudou.** Se uma reinvocação só emitiu o JSON (0 ferramentas, `git diff` vazio vs. snapshot), pular o juiz novo e reaproveitar o veredito/verificação da tentativa anterior.

### P1 — velocidade operacional

**P1.5 Modo `fanout` no packet.** `slices: [{id, writeRoots, instructions}]` dentro de um nó: o runner lança N workers (P0.2) e roda **uma** verificação/juiz no fim. É exatamente o que funcionou hoje (explain ∥ bridge ∥ docs).

**P1.6 Ambiente pinado.** O runner exporta para os workers o ambiente do contrato (`env: {ASDF_NODEJS_VERSION: "24.9.0"}`) e roda `preflight` que falha cedo se `node --version`/`pnpm --version` divergem. Evita o S13/Node 26 de hoje.

### P2 — UX

- `status --follow`: última ferramenta do worker, turnos, tokens/turno, US$ acumulado.
- `campaign` com painel de custo por fase (o ledger já existe: `usagePolicy`, `UsageLedgerEpoch`).
- Notificação (Ford) só em transições (done/failed/needs-human), com resumo de 3 linhas.

## 4. O que manter (funcionou)

- Verificação determinística por comando + snapshot de escopo (a ideia; ajustar a severidade — P0.8).
- Registro em `.runs/` (events, prompts, verification, logs) — foi o que permitiu esta análise e reaproveitar trabalho de nós "failed".
- `continuation` (fresh/reuse/rotate) — só falta o gatilho automático.
- Bloco de sinal no AGENTS.md + HANDOFF de campanha.
- Ledger de uso por época.

## 5. Ordem sugerida de implementação

1. P0.6 + P0.7 (resultado por arquivo, sem background) — 1 dia, elimina a classe de falha mais frequente.
2. P0.8 + P0.9 (escopo por arquivo/severidade, snapshot) — 1 dia.
3. P0.1 (rotação automática) + P1.1 (truncar saída) — 1–2 dias; maior ganho de custo.
4. P0.2 + P1.5 (paralelismo por disjunção, fanout) — 2 dias; maior ganho de relógio.
5. P0.3 + P1.3 (juiz condicional, roteamento) — 1 dia.
6. P0.4, P0.5, P0.10, P0.11, P1.6 — incrementais.

Meta mensurável (replicar a campanha edge-poc): 7 nós hoje ≈ 6–7 h e ~US$ 120 → com P0 completo ≈ 2–2,5 h e ~US$ 30–40.

## 6. Requisitos arquiteturais inspirados no agent-orchestrator

Referência: [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator). O escopo é exclusivamente o dos invariantes e da engenharia de documentação abaixo. UI, Electron, mobile, cloud, Nix e a escala do produto de referência são não objetivos.

### P0.12 Fatos duráveis; estado derivado; evidência selada

O control plane persiste fatos de execução, não status de exibição congelado. `working`, `needs_input`, `stalled`, `exhausted`, `failed`, `mergeable` e estados equivalentes são derivados na leitura por uma função pura, versionada e testada.

O artefato de auditoria é deliberadamente diferente: `trace.json` sela os fatos usados, o status derivado, a versão da derivação e a identidade imutável do controller. Atualizar o código pode mudar a projeção de um run ativo, mas nunca reescrever o veredito histórico já selado.

Criar `docs/adr/0010-durable-facts-derived-status.md` com alternativas, decisão, efeitos sobre runs existentes e o limite entre estado operacional e evidência.

Critérios de aceite:

- stores de run/nó registram fatos canônicos suficientes para reconstruir o status;
- render/status/campaign derivam a projeção por uma única função versionada;
- `trace.json` registra `derivationVersion`, fatos, projeção e identidade do controller;
- testes provam mudança de precedência sem migração de fatos e imutabilidade do trace selado.

### P0.13 Cursores de acknowledgement

Todo consumidor durável (`supervise`, autonomia de campanha, notificações e `campaign watch` quando houver efeito associado) separa observação, efeito e acknowledgement. O cursor de correção avança somente depois que o efeito foi confirmado e persistido. Crash entre efeito e ack pode reentregar; a reação deve ser idempotente. Crash antes do efeito não pode perder o evento.

ETags, offsets de leitura, timestamps e caches são estado de desempenho. Intents, settlements, hashes semânticos e acknowledgements confirmados são estado de correção. Estado de desempenho nunca pode avançar além de observação ainda não persistida/consumida.

Criar `docs/adr/0011-acknowledged-consumption-cursors.md` documentando a janela de crash, reentrega e idempotência.

Critérios de aceite:

- testes injetam crash antes do efeito, depois do efeito e antes do ack;
- nenhum evento é perdido; efeitos exatos-uma-vez permanecem exatos via identidade idempotente;
- cursores de leitura/performance não são usados como prova de consumo.

### P0.14 Documentação gerada a partir do código

Blocos de esquema, exemplos de cápsula, tabelas de estados e matrizes de capacidades têm uma fonte executável única. Um gerador determinístico produz os fragmentos documentais; arquivos gerados são identificados e não editados manualmente. O CI regenera e exige diff vazio.

Criar `docs/adr/0012-generated-contract-documentation.md` com a decisão code-first e remover literais duplicados de limites/esquemas.

Critérios de aceite:

- o exemplo de cápsula e seus limites saem de `capsule.mjs`/schema canônico;
- tabela de estados e matriz de adapters saem dos registries canônicos;
- `npm run docs:generate` é idempotente;
- `npm run docs:check` falha quando a documentação gerada diverge;
- nenhum teste extrai um exemplo manual como segunda fonte de verdade.

### P1.7 Mapa curto de regras load-bearing

Extrair 12–15 invariantes imperativos e verificáveis para uma seção `Load-bearing rules`. Cada regra inclui uma justificativa curta ou um link para ADR/referência. A lista deve incluir, no mínimo: fatos versus projeções, trace selado, probe não prova morte, adoção antes de retry, exact-once intent/settlement, cursor só após efeito, escopo por fatos do filesystem, nenhum status por heartbeat, nenhum transcript em cápsula/retrospectiva, adapters como folhas, nenhuma autoridade ampliada por findings, retrospectiva antes de close e symlinks de orientação.

### P1.8 Conhecimento separado por tipo e SKILL como roteador

Reestruturar por fronteira semântica, não por tamanho:

| Artefato | Conteúdo permitido |
|---|---|
| `CONTEXT.md` | termos e vocabulário; sem implementação ou decisões |
| `docs/adr/` | decisões, alternativas e consequências |
| `references/` | como protocolos e subsistemas funcionam |
| `AGENTS.md` | como trabalhar no repositório e fronteiras duras |
| `SKILL.md` | roteador curto, workflow operacional e load-bearing rules |

Criar `docs/README.md` como índice de duas colunas (`documento`, `o que cobre`) mais um modelo mental de no máximo cinco linhas. Cada documento declara sua fronteira para impedir crescimento por mistura de tipos.

### P1.9 Documentar o defeito que originou cada invariante

Para invariantes nascidos de falhas reais, registrar: sintoma, derivações independentes, evento que causou divergência, regra resultante e teste que impede regressão. O primeiro caso obrigatório é o limite de cápsula antes da centralização: literais divergentes em `capsule.mjs`, `runner.mjs` e documentação.

Criar uma seção de invariantes duráveis e uma narrativa `Capsule limits before centralization` na referência pertinente. Explicar por que caches/offsets são desempenho e fatos/hashes/settlements são correção.

### P1.10 Arquivos de orientação como ponteiros

`AGENTS.md` continua sendo a única fonte. `AGENT.md`, `CLAUDE.md`, `CURSOR.md` e `GEMINI.md` devem ser symlinks para ele; nunca cópias ou arquivos editáveis independentes. O estado atual já atende ao requisito. Acrescentar uma verificação automática que falha se qualquer ponteiro virar arquivo real ou apontar para outro destino.

### Ordem adicional de implementação

7. P0.12 + P0.13 (fatos derivados e acknowledgement) — antes de mudar mais estados/consumidores.
8. P0.14 (docs code-first) — elimina fontes duplicadas antes da dieta documental.
9. P1.7–P1.10 (load-bearing rules, taxonomia, narrativa dos bugs e verificação de symlinks) — fechar junto da documentação e retrospectiva obrigatória.

## 7. Retrospectiva obrigatória de campanha

Toda campanha executa exatamente uma fase de retrospectiva depois que os runs de entrega/reparo terminam e antes de `campaign.completed`/`close`. Ela consome apenas evidência durável, limitada e redigida; registra resultados, falhas, custo, tempo, revisões e melhorias priorizadas em `RETROSPECTIVE.md` dentro da campanha.

A ação é persistida antes do dispatch, retomável e idempotente. Runs marcados como retrospectiva não disparam outra retrospectiva. Falha, artefato ausente/inválido ou orçamento esgotado deixa a campanha em `attention`; nunca fecha silenciosamente. A retrospectiva não amplia autoridade para merge, deploy, credenciais, dados ou ações destrutivas.
