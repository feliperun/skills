# Manual de utilização do harness

O harness executa planos como um grafo de tarefas fora do contexto da sessão
principal. Cada tarefa pode usar um modelo diferente, receber uma revisão
independente e repetir automaticamente quando um gate encontrar um problema.

A sessão do Claude Code ou Codex continua sendo a central de controle. Não há
HTML nem TUI: o progresso fica em `.runs/<id>/STATUS.md`, que pode ser consultado
com `/btw` sem trazer logs inteiros para a conversa.

## 1. Pré-requisitos

- Node.js 20 ou superior.
- Claude CLI autenticada para runtimes com `driver: "claude"`.
- Codex CLI autenticado para runtimes com `driver: "codex"`.
- `DEEPSEEK_API_KEY` exportada quando o DeepSeek for usado.
- `.runs/` no `.gitignore` do repositório que receberá as alterações.

Verifique o ambiente sem revelar credenciais:

```bash
node --version
claude --version
codex --version
test -n "${DEEPSEEK_API_KEY:-}" && echo "DeepSeek configurado"
```

A skill está disponível como `$run-harness` no Claude e no Codex. Para usar o
CLI diretamente:

```bash
HARNESS_CLI="$HOME/.codex/skills/run-harness/scripts/harness.mjs"
```

## 2. Fluxo recomendado

1. Escreva ou aprove um plano.
2. Quebre o plano em nós pequenos, verificáveis e com dependências explícitas.
3. Inspecione o repositório uma vez, crie o contrato JSON e um task packet fechado para cada nó.
4. Valide o contrato antes de gastar tokens.
5. Execute o run em background.
6. Consulte o progresso por `/btw` ou pelo comando `status`.
7. Abra logs somente quando um estado exigir diagnóstico.

Estrutura sugerida no repositório alvo:

```text
.harness/
  feature-42.json
  packets/
    frontend.json
    backend.json
    migration.json
.runs/                  # gerado e ignorado pelo Git
```

Como o contrato está dentro de `.harness/`, use `"cwd": ".."` para apontar os
workers à raiz do repositório. Caminhos de `taskPacketFile` são relativos ao contrato.

## 3. Exemplo completo

```json
{
  "id": "feature-42",
  "campaignId": "feature-42",
  "goal": "Implementar a feature 42 com testes e revisão independente",
  "cwd": "..",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 1800,
  "runtimeDefaults": {
    "worker": "luna",
    "judge": "sol"
  },
  "runtimes": {
    "opus": {
      "driver": "claude",
      "model": "opus",
      "reasoning": "high",
      "permissionMode": "acceptEdits"
    },
    "luna": {
      "driver": "codex",
      "model": "gpt-5.6-luna",
      "reasoning": "xhigh"
    },
    "flash": {
      "driver": "codex",
      "model": "deepseek-v4-flash",
      "reasoning": "low",
      "config": {
        "model_provider": "deepseek",
        "model_providers.deepseek.name": "DeepSeek",
        "model_providers.deepseek.base_url": "https://api.deepseek.com/v1",
        "model_providers.deepseek.env_key": "DEEPSEEK_API_KEY",
        "model_providers.deepseek.wire_api": "responses",
        "model_providers.deepseek.requires_openai_auth": false
      }
    },
    "sol": {
      "driver": "codex",
      "model": "gpt-5.6-sol",
      "reasoning": "xhigh"
    }
  },
  "runtimeRules": [
    { "match": { "type": "frontend" }, "runtime": "opus" },
    { "match": { "type": "mechanic" }, "runtime": "flash" }
  ],
  "nodes": [
    {
      "id": "frontend",
      "type": "frontend",
      "taskPacketFile": "packets/frontend.json",
      "dependsOn": [],
      "definitionOfDone": [
        "A interface implementa os estados descritos na spec",
        "Os testes relevantes passam",
        "A alteração não introduz regressões visuais conhecidas"
      ],
      "gate": {
        "failOn": ["critical"],
        "maxRevisions": 1
      }
    },
    {
      "id": "backend",
      "type": "backend",
      "taskPacketFile": "packets/backend.json",
      "dependsOn": [],
      "definitionOfDone": [
        "O comportamento solicitado está implementado",
        "Os testes automatizados passam",
        "Nenhum arquivo fora do escopo foi alterado"
      ],
      "gate": {
        "failOn": ["critical", "major"],
        "maxRevisions": 1
      }
    },
    {
      "id": "migration",
      "type": "mechanic",
      "taskPacketFile": "packets/migration.json",
      "dependsOn": ["backend"],
      "definitionOfDone": [
        "A transformação é determinística",
        "Casos inválidos possuem testes",
        "A suíte completa passa"
      ],
      "gate": false
    }
  ]
}
```

Com esse contrato:

- `frontend` usa Opus porque corresponde à regra `type: frontend`.
- `backend` usa Luna porque nenhuma regra específica corresponde e ele recebe o
  runtime worker padrão.
- `migration` usa DeepSeek Flash porque corresponde a `type: mechanic`.
- Os gates de `frontend` e `backend` usam Sol.
- `migration` só começa depois de `backend` terminar como `done`.

`stallTimeoutSec` limita o silêncio de stdout e stderr. `timeoutSec` limita uma
invocação de provider, não o nó inteiro: worker e judge recebem cada um o seu, e
pode ser sobrescrito por nó. Os dois usam relógio monótono e ignoram o tempo em
que a máquina esteve suspensa.

## 4. Como escrever um bom nó

Um nó deve caber em uma única responsabilidade e terminar com uma verificação
objetiva. Prefira um task packet por arquivo para tarefas reais.

Exemplo de `packets/backend.json`:

```json
{
  "mode": "execution",
  "objective": "Implementar a validação de idempotência descrita em docs/SPEC.md",
  "instructions": [
    "Implementar apenas em src/idempotency/",
    "Adicionar cobertura em tests/idempotency/",
    "Reportar o resultado real dos testes"
  ],
  "readFiles": ["docs/SPEC.md", "src/idempotency/existing.ts"],
  "writeFiles": ["src/idempotency/validator.ts", "tests/idempotency/validator.test.ts"],
  "symbols": ["ExistingIdempotency"],
  "decisions": ["Não alterar APIs fora do módulo"],
  "nonGoals": ["Commit, push, merge ou deploy"],
  "verification": ["node --test tests/idempotency/validator.test.ts"]
}
```

O packet de execução é fechado: o worker só inspeciona `readFiles`, só edita
`writeFiles` e só executa `verification`. Se faltar um arquivo ou fato, deve
parar com `BLOCKED_CONTEXT: <arquivo ou fato ausente>` em vez de explorar o
repositório novamente. O juiz recebe o mesmo conjunto fechado: inspeciona apenas
os `writeFiles`, executa apenas a verificação listada e não faz descoberta
repositório-afora.

Use `taskPacket` inline no JSON apenas para tarefas muito curtas. O contrato
aceita exatamente um entre `taskPacket` e `taskPacketFile`; os campos
`prompt`/`promptFile` não existem mais.

Um nó de descoberta é a exceção: use `"mode": "discovery"` somente quando o
orquestrador realmente não conseguiu produzir um packet de execução. Ele é
read-only, não edita o repositório e deve retornar um novo packet de execução.
Se `readFiles` estiver vazio, essa é a única exceção à inspeção fechada: o
worker pode inspecionar o repositório somente em modo leitura para produzir o
packet; com `readFiles` preenchido, continua limitado aos arquivos listados.

### Campanha e custo de tokens

Toda execução pertence a uma campanha (`campaignId` obrigatório). Inicialize a
memória durável uma vez e use-a entre execuções:

```bash
"$HARNESS_CLI" campaign init feature-42 --goal "Implementar a feature 42"
"$HARNESS_CLI" campaign attach feature-42 --tool codex --session-id <id> --no-transcript
"$HARNESS_CLI" campaign note feature-42 --session-id <id> --kind decision --decision-id d1 --text "Usar packets fechados"
"$HARNESS_CLI" campaign show feature-42
```

Isso cria `.runs/campaigns/feature-42/` com `campaign.json`, `journal.jsonl`
apendável e sincronizado em disco, e `HANDOFF.md`. Vários runs podem ser
vinculados à mesma campanha; o handoff reúne intenções recentes do usuário,
decisões, restrições, resultados, próximo passo e linhagem de sessões em uma
projeção limitada a 16 KiB, mas o journal completo é preservado.
Estado que não foi gravado no journal nem em transcript/hook/wrapper não pode
ser recuperado após um crash.

O tradeoff de tokens é intencional: o orquestrador paga uma única inspeção do
repositório e a registra em packets fechados. Esse custo é amortizado entre
workers, juízes e retries; sem o packet, cada processo filho repetiria a
descoberta e queimaria contexto e latência.

## 5. Roteamento de modelos

O runtime do worker é resolvido nesta ordem:

1. `nodes[].runtime`, quando o nó força um runtime.
2. A primeira entrada correspondente em `runtimeRules`.
3. `runtimeDefaults.worker`.

O runtime do gate vem de `nodes[].gate.runtime` ou de
`runtimeDefaults.judge`.

Para forçar um nó específico a usar Terra, por exemplo, declare o runtime no
catálogo e referencie-o no nó:

```json
{
  "runtimes": {
    "terra": {
      "driver": "codex",
      "model": "gpt-5.6-terra",
      "reasoning": "high"
    }
  },
  "nodes": [
    {
      "id": "investigation",
      "type": "backend",
      "runtime": "terra",
      "taskPacketFile": "packets/investigation.json"
    }
  ]
}
```

Não use `--profile flash`. O Codex 0.147.0 aceita profiles inexistentes sem
erro e pode executar o provider padrão. O harness envia toda a configuração do
DeepSeek como overrides `-c` e exige a variável de ambiente.

## 6. Validar e executar

Valide o contrato:

```bash
node "$HARNESS_CLI" validate .harness/feature-42.json
```

Saída esperada:

```text
valid
```

Antes de gastar tokens, faça o preflight:

```bash
node "$HARNESS_CLI" preflight .harness/feature-42.json
```

```text
[ok] luna · codex/gpt-5.6-luna answered
[fail] deepseek · Codex integration with deepseek-v4-pro will be available starting early August 2026.
```

O preflight faz uma chamada real e read-only para cada runtime de worker e de
judge que o contrato realmente roteia, com o modelo exato declarado, e não cria
nenhum estado. Ele sai com código 1 quando algum runtime falha. Credencial
válida não significa que o provider serve aquele modelo: um provider pode
recusar um modelo da família e servir outro.

Pela sessão, a forma preferida é pedir:

```text
Use $run-harness para executar .harness/feature-42.json em background.
```

Também é possível iniciar manualmente. O modo recomendado destaca o controlador
em um grupo de processos próprio, de modo que ele sobreviva ao fim da sessão
que o iniciou:

```bash
node "$HARNESS_CLI" run --detach .harness/feature-42.json
# [run] feature-42 detached · pid 12345 · <repo>/.runs/feature-42
```

O comando recusa sobrescrever `.runs/<id>`. Escolha um novo `id` apenas quando o
roteamento ou o próprio grafo mudarem. Para continuar um run interrompido, use
`resume` sobre o diretório existente, também destacado:

```bash
node "$HARNESS_CLI" resume --detach .runs/feature-42
```

Sem `--detach`, o controlador morre junto com a sessão que o iniciou; um nó
`running` vira órfão até o próximo `resume`. O `resume` adota o log do worker
cujo próprio stream prova que a rodada terminou, re-julga em vez de
reimplementar quando o nó tem gate, e reinicia somente o que não deixou saída
aproveitável. Ele não recupera uma rodada interrompida no meio: um provider
morto durante a execução refaz o nó inteiro.

## 7. Acompanhar pela sessão

Durante uma conversa no Claude Code, consulte sem sair da central de controle:

```text
/btw qual é o status do run feature-42? Leia .runs/feature-42/STATUS.md.
```

Para conferir processos ativos, use `/tasks`. Para obter o snapshot pelo CLI:

```bash
node "$HARNESS_CLI" status .runs/feature-42
```

O snapshot mostra nó, estado, runtime resolvido, tentativa atual e o resumo do
gate ou erro. O comando também atualiza `STATUS.md`.

O status também compara o PID gravado em `run.json` com os processos vivos. Um
nó `running` cujo processo controlador morreu é um órfão, não trabalho em
andamento, e aparece nomeado em "Needs you". O worker é destacado e pode
sobreviver ao controlador, terminar o trabalho e gravar tudo em disco sem que
ninguém leia o resultado: é exatamente esse caso que o `resume` recupera.

## 8. Estados

| Estado | Significado | Ação habitual |
| --- | --- | --- |
| `pending` | Aguarda dependências ou vaga de execução | Nenhuma |
| `running` | Worker ou judge está executando | Acompanhar por status |
| `done` | Trabalho aceito, inclusive pelo gate | Nenhuma |
| `no-op` | Worker terminou sem resultado | Revisar task packet e escopo |
| `blocked` | Permissão ou dependência impediu o nó | Resolver a causa indicada |
| `failed` | Provider, comando ou saída falhou | Ler erro; abrir log se necessário |
| `exhausted` | Estourou tempo total ou revisões | Redividir o nó ou ajustar o limite |
| `stalled` | Não houve saída dentro da janela | Verificar provider, rede e task packet |
| `canceled` | Execução foi interrompida | Criar novo run se quiser repetir |

Um dependente só executa quando todas as dependências terminam como `done`. Se
uma dependência falhar, o dependente termina como `blocked`.

## 9. Gates e revisões

`gate: false` desativa a revisão do nó. Um objeto `gate` ativa um judge com
saída JSON estruturada.

```json
{
  "gate": {
    "runtime": "sol",
    "failOn": ["critical"],
    "maxRevisions": 1
  }
}
```

- `failOn` define quais severidades rejeitam a tentativa.
- Achados abaixo do limiar ficam registrados como recomendações.
- `maxRevisions: 1` permite uma correção depois da primeira reprovação.
- Ao atingir o limite, o nó termina como `exhausted`.

Comece com `failOn: ["critical"]`. O POC encontrou achados corretos no Sol, mas
também observou severidade agressiva; incluir `major` aumenta a qualidade e o
custo de retrabalho.

## 10. Paralelismo

Use `maxParallel: 1` por padrão. O v0 ainda não cria worktrees separados, então
dois workers simultâneos no mesmo repositório podem editar os mesmos arquivos.

Use valores maiores somente quando os nós escreverem em diretórios comprovadamente
disjuntos. Dependências continuam sendo respeitadas mesmo com paralelismo.

## 11. Arquivos gerados

```text
.runs/<id>/
  contract.json
  run.json
  judge.schema.json
  nodes/<node>.json
  logs/<node>.<tentativa>.<worker|judge>[.r<n>].jsonl
  logs/<node>.<tentativa>.<worker|judge>[.r<n>].err
  events.jsonl
  STATUS.md
```

- `STATUS.md`: visão normal para o operador e para `/btw`.
- `contract.json`: contrato com todos os task packets embutidos e sem o prompt
  gerado internamente, o que torna o diretório um registro completo e retomável.
- `run.json`: PID do processo controlador, usado para detectar órfãos.
- `nodes/*.json`: estado canônico de cada nó.
- `events.jsonl`: transições de estado.
- `logs/*.jsonl`: saída bruta do provider.
- `logs/*.err`: stderr, incluindo avisos e falhas de transporte.

Evite ler logs em execuções saudáveis. Quando necessário:

```bash
tail -100 .runs/feature-42/logs/backend.1.worker.err
tail -100 .runs/feature-42/logs/backend.1.worker.jsonl
```

## 12. Diagnóstico rápido

### `run already exists`

O `id` já possui um diretório em `.runs/`. Se o objetivo é continuar aquele
mesmo trabalho, use `resume` no diretório existente. Escolha um novo id apenas
quando o roteamento ou o grafo mudarem. Não apague um run automaticamente,
porque ele contém o histórico e os diagnósticos.

### Nó preso em `running`

Confira o status: se o processo controlador morreu, o snapshot nomeia os nós
órfãos. Rode `resume` no diretório do run. O trabalho já concluído pelo worker
é adotado a partir do log, sem pagar de novo pelo mesmo nó.

### `missing environment variable DEEPSEEK_API_KEY` no preflight

Exporte a chave em um shell novo e repita o preflight:

```bash
test -n "${DEEPSEEK_API_KEY:-}" && echo "configurada"
```

Não coloque o valor da chave no contrato. O preflight reporta apenas o nome da
variável, nunca o valor.

### Aviso `missing field models` no DeepSeek

O catálogo do DeepSeek usa um formato diferente do esperado por esta versão do
Codex. O aviso é conhecido e pode ser não fatal. Confirme que existe
`turn.completed`; sem ele, trate a execução como falha.

### `stalled`

O worker deixou de atualizar stdout e stderr por `stallTimeoutSec`. Verifique
rede, provider e o último evento. Aumente a janela apenas quando houver evidência
de que o modelo fica legitimamente silencioso por mais tempo.

### `exhausted`

Uma invocação de provider ultrapassou `timeoutSec`, ou o nó consumiu todas as
revisões permitidas. O limite é por invocação: worker e judge têm cada um o seu,
e um worker lento não come o orçamento do revisor. Prefira quebrar o nó em
tarefas menores antes de simplesmente aumentar limites.

Prazos e stall são medidos em relógio monótono, que não avança enquanto o host
está suspenso. Fechar a tampa do notebook pausa o run; não mata o nó que estava
executando.

### Claude termina como `blocked`

`permissionMode: "acceptEdits"` pode negar operações não interativas. Use
`bypassPermissions` somente em repositório recuperável, com escopo restrito e
sem acesso de escrita a produção.

## 13. Segurança e limites do v0

- O harness não autoriza merge, deploy, escrita em produção ou operações
  destrutivas. Essas ações continuam exigindo aprovação humana.
- Segredos devem existir apenas no ambiente.
- `resume` recupera uma rodada de worker concluída, nunca uma parcial.
- Não existe isolamento automático por worktree.
- Tokens ainda são medidos, mas não limitados por orçamento.
- O harness não possui UI própria nem serviço residente.

Para detalhes formais do contrato, consulte
[`skills/run-harness/references/contract.md`](../skills/run-harness/references/contract.md).
