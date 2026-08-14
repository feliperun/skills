# harness

Repositório de skills para executar trabalho de agentes com contexto pequeno,
estado recuperável e revisão independente.

## Problemas que resolve

- Subagentes que gastam contexto explorando o mesmo repositório repetidamente.
- Uma sessão que cai, troca de harness ou fica sem créditos e perde decisões.
- Runs longos sem status confiável, orçamento, recuperação ou histórico de gate.
- Workers e juízes que usam o mesmo modelo e repetem o mesmo viés.

O `run-harness` mantém o orquestrador como plano de controle: ele explora o
repositório uma vez, grava essa descoberta em task packets fechados e delega só
o contexto necessário. Estado, logs e status ficam no repositório alvo, em
`.runs/`, nunca na conversa principal.

```text
orquestrador ──> campanha / HANDOFF.md ──> contrato DAG + task packets
                                                │
                              workers ──> gate independente ──> .runs/<id>/STATUS.md
```

## Quickstart

No repositório que receberá a implementação, ignore `.runs/` e escolha um id
de campanha que represente o objetivo, não uma sessão individual.

```bash
HARNESS=/caminho/para/harness/skills/run-harness/scripts/harness.mjs
TARGET=/caminho/para/repo-alvo

rg -qxF '.runs/' "$TARGET/.gitignore" || printf '\n.runs/\n' >> "$TARGET/.gitignore"
node "$HARNESS" campaign init feature-42 --cwd "$TARGET" --goal "Entregar feature 42"
node "$HARNESS" campaign attach feature-42 --cwd "$TARGET" \
  --tool codex --session-id <id-da-sessao> --no-transcript
```

Inspecione o alvo uma única vez. Em seguida crie `.harness/feature-42.json` e
os packets que ele referencia. Um packet de execução tem escopo explícito:

```json
{
  "mode": "execution",
  "objective": "Adicionar a validação de idempotência",
  "instructions": ["Implementar somente o comportamento descrito"],
  "readFiles": ["docs/SPEC.md", "src/idempotency.ts"],
  "writeFiles": ["src/idempotency.ts", "test/idempotency.test.ts"],
  "symbols": ["validateIdempotency"],
  "decisions": ["Não alterar a API pública"],
  "nonGoals": ["Commit, deploy ou descoberta adicional"],
  "verification": ["node --test test/idempotency.test.ts"]
}
```

O contrato define a campanha, runtimes, grafo e Definition of Done. A referência
completa está em [contract.md](skills/run-harness/references/contract.md).
Antes de gastar tokens, valide as rotas e faça preflight:

```bash
node "$HARNESS" validate "$TARGET/.harness/feature-42.json"
node "$HARNESS" preflight "$TARGET/.harness/feature-42.json"
node "$HARNESS" run --detach "$TARGET/.harness/feature-42.json"
```

## Como operar um run

| Objetivo | Comando |
| --- | --- |
| Ver handoff antes de retomar | `campaign show <campanha> --cwd <repo>` |
| Registrar uma decisão ou resultado | `campaign note <campanha> --session-id <id> --kind <tipo> --text <texto>` |
| Anexar uma nova sessão | `campaign attach <campanha> --tool <tool> --session-id <id> --transcript <path> --format <formato>` |
| Validar contrato | `validate <contract.json>` |
| Verificar credenciais e modelos | `preflight <contract.json>` |
| Iniciar sem prender a sessão | `run --detach <contract.json>` |
| Ler o estado atual | `status <run-dir>` |
| Ver tentativas e tokens | `report <run-dir>` |
| Preparar um reparo após gate esgotado | `findings <run-dir>` |
| Retomar run interrompido | `resume --detach <run-dir>` |
| Vigiar e retomar controlador morto | `watch --detach <run-dir>` |

Todos os comandos acima são subcomandos de `node "$HARNESS"`. A campanha
mantém `campaign.json`, um `journal.jsonl` append-only e um `HANDOFF.md` limitado
a 16 KiB. Ao trocar de Codex, Claude Code, Cursor ou cloud harness, leia o
handoff, anexe a nova sessão e continue; só abra o transcript original quando
precisar de detalhe que não foi resumido.

## Papéis dos agentes

| Papel | Responsabilidade |
| --- | --- |
| Orquestrador | Lê o handoff, explora o repositório uma vez, cria packets, escolhe runtimes e decide próximos passos. |
| Worker | Executa um nó dentro de `readFiles`, `writeFiles` e `verification`; reporta `BLOCKED_CONTEXT` quando falta contexto. |
| Judge | Inspeciona só os arquivos de saída e a verificação declarada; devolve um veredito JSON independente. |
| Watcher | Detecta um controlador morto e dispara `resume --detach`; não substitui o orquestrador. |

O worker não é dono de descoberta. Um nó `mode: "discovery"` read-only é a
única exceção e deve produzir um packet de execução para o próximo nó.

## Runtimes e modelos suportados

O harness suporta três drivers e roteia tudo declarativamente pelo contrato.
Os nomes abaixo são configurações testadas; um driver também pode receber outro
modelo compatível.

| Driver | Modelos/configurações | Uso recomendado |
| --- | --- | --- |
| `codex` | GPT-5.6 Luna, Terra, Sol | Implementação limitada, tarefas gerais e review independente. |
| `claude` | Opus | Trabalho de frontend ou apresentação quando o ganho justifica custo e startup. |
| `codex` + provider customizado | DeepSeek V4 Flash e V4 Pro | Flash para trabalho mecânico bem especificado; Pro quando um worker ou judge mais profundo justificar o custo. |
| `agy` | Modelos aceitos pelo CLI `agy` (ex.: Gemini Flash) | Runtimes já disponíveis nesse driver. |

Para DeepSeek, a configuração do provider é declarada em `runtimes[].config` e
o harness a passa como overrides `-c`; não use profiles. `preflight` é obrigatório
para confirmar que a credencial serve o modelo escolhido.

## Política operacional

- O timeout padrão é 40 minutos (`2400` segundos). Declare `4800` segundos por
  nó para trabalho profile-wide ou browser-heavy; não deixe a escolha implícita.
- Após duas rejeições de gate ou um estado `exhausted`, use `findings` e crie um
  fix node de propósito único. Não copie o grafo inteiro nem continue retry cego.
- Faça `report` ao fim de todo run. O total de tokens e revisões mostra padrões
  de custo antes de eles virarem hábito.
- Enquanto um run vive, trabalhe apenas em paths disjuntos e faça staging
  seletivo. O harness não isola worktrees concorrentes.

## Outras skills

`init-harness` instala governança básica em outro repositório: `AGENTS.md`
canônico, symlinks para outros harnesses, documentação inicial, ADRs, Sentrux,
CI e hooks. Consulte [SKILL.md](skills/init-harness/SKILL.md) antes de usá-la.

## Convenções deste repositório

[AGENTS.md](AGENTS.md) é a orientação canônica; `CLAUDE.md`, `GEMINI.md`,
`CURSOR.md`, `AGENT.md` e `.github/copilot-instructions.md` são symlinks e não
devem ser editados diretamente. Estado de runs é local e ignorado pelo Git.

## License

[MIT](LICENSE).
