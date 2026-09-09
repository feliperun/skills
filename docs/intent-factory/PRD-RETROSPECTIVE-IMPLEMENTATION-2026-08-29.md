# Intent Factory: eficiência, robustez e aprendizagem contínua

## Resumo Executivo

Implementar a spec `RETROSPECTIVE-2026-08-28.md` para reduzir custo e duração das campanhas, eliminar falhas recorrentes de protocolo/escopo e tornar a retrospectiva uma fase obrigatória antes do fechamento. Incorporar padrões não-UI do `Untrivial-ai/agent-orchestrator`: fatos duráveis com projeções derivadas, cursores confirmados, documentação code-first e conhecimento separado por tipo.

## Problema

Campanhas reais consumiram até centenas de turnos por nó, releram centenas de milhões de tokens em cache, repetiram suítes e juízes caros, serializaram trabalho disjunto e perderam tempo com falhas recuperáveis. Estado operacional e documentação também possuem derivações duplicadas, o que aumenta risco de inconsistência e custo de contexto. Hoje o encerramento não garante que a campanha transforme seus próprios dados em melhorias priorizadas.

## Solução Proposta

Evoluir o runner e o control plane em sete checkpoints:

1. resultado durável, recuperação de um turno, foreground obrigatório, truncamento e rotação automática;
2. escopo por arquivo/diretório, derivados convencionais, snapshot resiliente e contratos estritos;
3. paralelismo seguro por disjunção e fanout/fanin;
4. gates por risco, verificação fast/full, preflight único, orçamento de contexto e routing por tipo;
5. supervisão automática, pause, ambiente pinado, status streaming e custo por fase;
6. fatos duráveis/projeções derivadas, trace selado, cursores de acknowledgement e docs geradas;
7. taxonomia documental, regras load-bearing e retrospectiva obrigatória.

## Usuários

- Orquestrador que transforma um plano aprovado em mudanças verificadas.
- Pessoa responsável por acompanhar custo, tempo, falhas e decisões de uma campanha.
- Agente que retoma uma campanha sem reler transcripts nem reinterpretar estado congelado.

## User Stories

- Como orquestrador, quero paralelizar trabalho comprovadamente disjunto sem perder isolamento ou retomada.
- Como operador, quero que uma falha de transporte, resultado ausente ou controller morto seja recuperada sem repetir trabalho caro.
- Como auditor, quero fatos canônicos e traces imutáveis que expliquem como cada veredito foi obtido.
- Como mantenedor, quero contratos e documentação gerados de uma fonte única para impedir divergência.
- Como time, quero que toda campanha termine com uma retrospectiva acionável antes de ser fechada.

## Requisitos Funcionais

### Execução e custo

- Implementar P0.1–P0.11, P1.1–P1.6 e todos os itens P2 da spec.
- Rotacionar em 80 turnos, 120 mil tokens de cache-read por turno ou `contextBudget` do nó.
- Persistir resultado canônico, tentar uma única continuação de recuperação e reaproveitar evidência quando não houve mudança.
- Usar `maxParallel` padrão 3 com análise determinística de files/roots e `sharedResources`.
- Separar `verification.fast` do loop do worker e `verification.full` do gate.

### Arquitetura do control plane

- Persistir fatos duráveis e derivar status operacional por função pura versionada.
- Selar fatos, projeção, `derivationVersion` e controller no `trace.json` de auditoria.
- Avançar cursores de correção somente depois do efeito persistido; aceitar reentrega idempotente.
- Tratar offsets/ETags/caches como desempenho, nunca como confirmação de consumo.

### Documentação e invariantes

- Criar ADR-0010 (fatos/projeções), ADR-0011 (acknowledgement) e ADR-0012 (docs code-first).
- Gerar exemplos de esquema, limites, estados e capacidades a partir dos registries canônicos; CI exige regeneração sem diff.
- Manter 12–15 regras load-bearing curtas, imperativas e verificáveis.
- Separar glossário (`CONTEXT.md`), decisões (`docs/adr/`), funcionamento (`references/`), modo de trabalho (`AGENTS.md`) e roteamento (`SKILL.md`).
- Criar `docs/README.md` como índice curto e documentar o bug que originou invariantes relevantes.
- Verificar que os quatro arquivos de orientação continuam symlinks para `AGENTS.md`; o estado atual já cumpre esse requisito.

### Aprendizagem contínua

- Executar exatamente uma retrospectiva após a entrega/reparo e antes de fechar a campanha.
- Produzir `RETROSPECTIVE.md` com evidência limitada/redigida, resultados, falhas, uso, custo, duração, revisões e melhorias priorizadas.
- Persistir identidade antes do dispatch, retomar após crash, impedir recursão e ir para `attention` quando a retrospectiva não concluir validamente.

## Requisitos Não-Funcionais

- Nenhuma dependência nova sem necessidade comprovada.
- Sem compatibilidade com formatos obsoletos; contratos inválidos falham cedo.
- Exact-once para intents, settlements, ações de campanha e acknowledgement.
- Nenhum transcript, segredo, host privado ou destinatário em cápsulas/retrospectivas.
- Findings e retrospectivas não ampliam autoridade de reparo, merge, deploy, credenciais ou destruição.
- Código Node.js 22+ idempotente, retomável e coberto por testes determinísticos de crash.

## Métricas de Sucesso

- Benchmark comparável da campanha edge-poc: sete nós em 2–2,5 h e US$ 30–40, contra 6–7 h e ~US$ 120; até o benchmark ser repetido, reportar como meta, não resultado.
- Contexto por turno abaixo de 150 mil tokens nos nós longos.
- Zero reinvocações completas causadas apenas por resultado estruturado ausente.
- Zero perda de evento nas janelas de crash antes/depois do efeito/ack.
- Toda campanha fechada possui uma retrospectiva válida e única.
- `npm run check`, `npm run typecheck`, `npm test` e checks de documentação/symlinks verdes.

## Fora de Escopo

- UI, Electron, mobile, cloud, Nix ou outras superfícies do agent-orchestrator.
- Worktrees ou coordenação distribuída além do scheduler local por escopo.
- Integrações privadas Ford/OpenClaw, destinatários ou credenciais.
- Merge, deploy ou acesso destrutivo concedido por autonomia da campanha.

## Riscos e Mitigações

- Paralelismo introduzir corrida: serializar qualquer interseção ambígua e recursos compartilhados.
- Estado derivado mudar interpretação histórica: traces selados preservam a decisão da época.
- Cursor confirmar cedo demais: persistir efeito antes de ack e testar crashes em cada janela.
- Retrospectiva recursiva ou bloqueante: marcar o papel do run e falhar para `attention` com limites existentes.
- Documentação voltar a divergir: gerar de código e falhar CI em diff.

## Referências

- `RETROSPECTIVE-2026-08-28.md`
- `SKILL.md`
- `references/contract.md`
- `references/campaign-autonomy.md`
- [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)
