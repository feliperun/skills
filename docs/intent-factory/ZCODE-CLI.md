# ZCode CLI — como o harness oficial da Z.ai funciona

Referência do CLI do **ZCode** (o harness oficial da Z.ai para os modelos GLM)
com foco no modo headless, que é o que a intent-factory consome através do
driver `zcode`. Tudo aqui foi levantado na versão **0.16.5** do CLI
(ZCode app 3.11.2, macOS arm64) em 2026-09-10: o que tem ✅ foi verificado ao
vivo; o que tem 🧩 foi lido direto do bundle (`zcode.cjs`) e não exercitado.

---

## 1. O que é

O ZCode se apresenta como um produto único com duas superfícies:

- **App desktop** (Electron, "Agentic Development Environment") — a superfície
  documentada em [zcode.z.ai](https://zcode.z.ai/en);
- **CLI** — um bundle Node de ~12,6 MB que o app embute e que também roda
  sozinho, com TUI interativa **e** modo headless de prompt único.

É o mesmo motor: esta sessão, por exemplo, roda dentro do ZCode. O CLI é o
análogo do `claude` (Claude Code) para o ecossistema GLM — com uma diferença
importante: **não há instalador de CLI separado**. O binário vive dentro do app.

## 2. Onde tudo vive (instalação padrão macOS)

| Artefato | Caminho |
| --- | --- |
| App | `/Applications/ZCode.app` |
| Bundle do CLI | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` |
| Dados do desktop | `~/.zcode/v2/` (`setting.json`, `config.json`, `credentials.json`) |
| Dados do CLI | `~/.zcode/cli/` (`config.json` esperado aqui, `log/`, `db/`, `rollout/`, `plugins/`) |
| Plugins embutidos | `/Applications/ZCode.app/Contents/Resources/glm/packages/` |

Não existe um executável `zcode` no `PATH` após instalar o app. Para uso em
automação, crie um shim. O detalhe crítico: **o CLI precisa do Node embutido do
Electron** — com Node de sistema (asdf 24.9.0 x64) o caminho de resposta quebra
com `Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer`.

```sh
#!/bin/sh
# ~/bin/zcode — shim do CLI do ZCode
ELECTRON_RUN_AS_NODE=1 exec /Applications/ZCode.app/Contents/MacOS/ZCode \
  /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs "$@"
```

✅ `zcode --version` → `0.16.5`; ✅ `zcode doctor` reporta `process: zcode-cli`,
`default artifact: node-bundle`.

## 3. Comandos

Saída de `zcode --help` (0.16.5):

```
app-server  Run the ZCode Protocol stdio app server
commands    List custom slash commands
doctor      Inspect runtime and packaging assumptions
login       Sign in with Z.AI OAuth for model access
logout      Remove the shared Z.AI login credentials
plugins     List and enable installed plugins
skills      List local skills
tui         Open the terminal UI
version     Print the CLI version
```

- Sem comando, abre a TUI. 🧩 `app-server` é o protocolo stdio que o app desktop
  usa para controlar o motor — não explorado aqui.
- ✅ `login` aceita variantes (visíveis no help do slash command): `zai-coding-plan`,
  `bigmodel-coding-plan`, `zai-coding-plan-api-key <api-key>`,
  `bigmodel-coding-plan-api-key <api-key>`. O login **escreve a API key final no
  `config.json`** do CLI.

## 4. Modo headless (o que a automação usa)

Forma verificada de rodar um prompt sem TUI:

```sh
zcode --prompt "Reply with exactly: pong" --json --mode plan --cwd /tmp/x --no-color
```

| Flag | Função | Status |
| --- | --- | --- |
| `--prompt <texto>` | Executa um prompt único e sai | ✅ |
| `--json` | Imprime o resultado em JSON legível por máquina | ✅ |
| `--mode <modo>` | `build`, `edit`, `plan` ou `yolo` (default `yolo` para `--prompt`) | ✅ |
| `--permission-mode <modo>` | Alias legado (`default`, `build`, `edit`, `plan`, `yolo`) | 🧩 |
| `--resume <sess_...>` | Retoma uma sessão persistida por id | ✅ |
| `-c, --continue` | Retoma a última sessão do diretório | 🧩 |
| `--cwd <path>` | Executa como se estivesse no diretório | ✅ |
| `--attach <path>` | Anexa arquivo local ao `--prompt` (repetível) | 🧩 |
| `--surface terminal\|desktop` | Superfície de apresentação do headless | 🧩 |
| `--target <texto>` | Define/persegue um objetivo de sessão | 🧩 |
| `--no-color`, `--verbose`, `--locale` | Presentation/diagnóstico | ✅/🧩 |
| `--browser-use headless`, `--browser-executable <path>` | Backend de Browser Use | 🧩 |

### ⚠️ Flags fantasma no help 0.16.5

O `--help` documenta opções que **o parser rejeita**:

- `--max-turns <n>` → `Unknown option`
- `--settings <path>` → `Unknown option`
- `--allowed-tools` / `--disallowed-tools` → `Unknown option`

O help está desatualizado em relação ao parser. Não construa automação em cima
delas sem testar na versão alvo.

## 5. Configuração em camadas

A configuração efetiva é merge das camadas (🧩 ordem observada no bundle:
defaults → user config → project config → env, com env vencendo):

### 5.1 Variáveis de ambiente (`ZCODE_*`)

🧩 Mapeamento extraído do parser de env do bundle:

| Variável | Efeito |
| --- | --- |
| `ZCODE_MODEL` | Modelo principal, formato `model` ou `provider/model` (ex.: `glm/glm-5.3`) |
| `ZCODE_BASE_URL` | Sobrescreve a baseURL do provider do `ZCODE_MODEL` |
| `ZCODE_API_KEY` | Último candidato de API key na resolução de auth |
| `ZCODE_STORAGE_DIR` / `ZCODE_SESSION_DB_PATH` | Realocam armazenamento/sessões |
| `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY` / `ZCODE_AGENT_CA_CERT` / `ZCODE_HTTP_TIMEOUT` | Rede (o app desktop ignora `HTTP_PROXY` do ambiente) |
| `ZCODE_LOG_DIR` / `ZCODE_LOG_FORMAT` (`text\|json`) / `ZCODE_LOG_CONSOLE` | Logging |
| `ZCODE_MAX_TOOL_CONCURRENCY` | Concorrência de tools |
| `ZCODE_DATA_BASE_DIR` | Raiz alternativa de dados (`~/.zcode`) |
| `ZCODE_TELEMETRY_*`, `ZCODE_DEBUG` | Telemetria/diagnóstico |

✅ `ZCODE_MODEL` + `ZCODE_BASE_URL` sozinhos configuram uma chamada completa —
nenhum arquivo é necessário.

### 5.2 User config — `~/.zcode/cli/config.json`

Sem nenhum modelo configurado o CLI morre com:
`Error: Model config is missing. Create ~/.zcode/cli/config.json with an
explicit model provider before running ZCode.` ✅

🧩 Schema do bloco de modelo (as entradas de modelo **registram os providers**;
não há bloco `providers` independente):

```json
{
  "model": {
    "main":  { "provider": "glm", "kind": "anthropic", "baseURL": "https://api.z.ai/api/anthropic", "model": "glm-5.3" },
    "lite":  { "provider": "glm", "model": "glm-5.3-flash" },
    "available": [ { "provider": "glm", "model": "glm-5.3-flash" } ]
  },
  "permission": { },
  "network": { },
  "storage": { },
  "plugins": { },
  "hooks": { }
}
```

Cada entrada aceita `kind` (`anthropic`, `openai`, `openai-compatible`),
`baseURL`, `apiKey` (inline) e `apiKeyEnv` (nome de variável). Um target
`"glm/glm-5.3"` cujo provider não tem entrada implícita vira
`openai-compatible` sem baseURL e falha com `Model provider glm is missing
baseURL`. ✅ (mensagem observada)

### 5.3 Project config — `<repo>/zcode.json` ou `<repo>/.zcode/config.json`

🧩 O CLI descobre config por projeto nesses dois caminhos (é a base do sistema
de **workspace hooks** do app: `hooks` por repositório, com `hooksRoot`
{`enabled`, `timeoutMs`, `maxOutputBytes`}). A layer de modelo também mergeia.

### 5.4 Providers builtin

🧩 Template embutido no bundle:

| Provider id | baseURL | Modelos no template |
| --- | --- | --- |
| `zai` (Z.AI Coding Plan) | `https://api.z.ai/api/anthropic` | `zai/glm-5.1`, `zai/glm-4.7` (desatualizado) |
| `bigmodel` (BigModel) | `https://open.bigmodel.cn/api/anthropic` | `bigmodel/glm-5.1`, `bigmodel/glm-4.7` |

⚠️ **A rota do provider `zai` é especial** (assina/roteia requisições do coding
plan). Sem o login próprio do CLI ela responde **404 Not Found**, mesmo com
API key válida — ✅ verificado. Usando um **provider id neutro** (`glm`) +
`ZCODE_BASE_URL`, a chamada Anthropic-compatível direta funciona sem OAuth. ✅

## 6. Autenticação

Ordem de resolução da API key por provider (🧩 `resolveApiKey` no bundle):

1. `apiKey` inline na entrada do provider (config);
2. Variável de ambiente: `apiKeyEnv` da entrada, senão o default do `kind`
   (`anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`),
   **mais** os derivados do nome do provider — `<PROVIDER>_API_KEY`
   (`glm` → `GLM_API_KEY`, `zai` → `ZAI_API_KEY`) — **mais** `ZCODE_API_KEY`;
3. Provedores `anthropic`/`openai`/`gateway` **exigem** key: sem nenhuma,
   `Error: Model provider <id> is missing an API key: <id>`. ✅

A variável lida é `process.env` do processo do CLI (sem filtragem). O OAuth
(`zcode login`) compartilha credenciais com o app desktop
(`~/.zcode/v2/credentials.json`: `oauth:zai:access_token`, `zcodejwttoken`), 🧩
mas o CLI mantém sua própria cópia da key no `config.json`.

## 7. Modelos

Verificados contra o endpoint do coding plan (Z.AI, `api.z.ai/api/anthropic`):

| Model id | Status |
| --- | --- |
| `glm-5.3` | ✅ funciona; 1M de janela reportado na projeção da sessão |
| `glm-5.3-flash` | ✅ funciona |
| `glm-5.3-pro` | ❌ `400 invalid_request_error` — `[1211][Unknown Model…]` |
| `glm-5.3-air` | ❌ `400` Unknown Model |

"Pro" é **tier do plano de assinatura**, não model id. O catálogo do app lista
`GLM-5.3` com variantes de reasoning `low`/`max`/`high` (default `max`), 🧩 mas
o CLI 0.16.5 não expõe flag de reasoning effort — o modelo decide o depth.
O sufixo `[1m]` é convenção do CLI do Claude Code para o tier de 1M de contexto;
o ZCode não o conhece (a janela vem do provider), e um `[1m]` num model id
gera Unknown Model. ✅

## 8. Saída do `--json`

O headless imprime **um único objeto JSON** (não é um stream NDJSON de eventos
como o `--output-format stream-json` do claude). Forma real ✅:

```json
{
  "sessionId": "sess_bf4de980-bd3a-43a1-9884-b88d610bf2a9",
  "traceId": "7ceb9c1a-d04f-4691-b2ff-b83f45c2db53",
  "turnId": "turn_aa9444ba-99b0-46b5-8675-077bcd008e71",
  "response": "pong",
  "usage": {
    "source": "provider",
    "modelRequestCount": 1,
    "inputTokens": 15506,
    "outputTokens": 109,
    "totalTokens": 15615,
    "cacheReadTokens": 9024,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0,
    "webFetchRequests": 0,
    "webSearchRequests": 0
  },
  "eventCount": 118,
  "projection": {
    "status": "idle",
    "turnCount": 1,
    "totalTokenCount": 15615,
    "contextUsed": 15615,
    "contextWindow": 1000000
  }
}
```

Pontos que importam para quem mede:

- **`inputTokens` já inclui os cache reads** — `totalTokens = inputTokens +
  outputTokens`. Para "input não-cacheado", subtraia `cacheReadTokens`. ✅
- `eventCount` conta os eventos internos da sessão; eles não são expostos.
- **Custo não é reportado** (nada equivalente ao `total_cost_usd` do claude).
- Falha antes do resultado: **stdout vazio + diagnóstico no stderr**, ex.:
  `Error: Model provider is missing an API key: zai` ✅ ou
  `Error: Turn execution failed (traceId: …)` ✅. Parsers de saída precisam
  tratar "sem JSON" como caminho normal de erro e ler o stderr.

## 9. Sessões e continuação

- `--resume <sess_...>` retoma o contexto persistido: ✅ na segunda chamada o
  cache read saltou para ~14,8k de ~15,6k input (quase tudo cacheado) e a
  resposta demonstrou memória do turno anterior.
- Sessões vivem no armazenamento do CLI (`~/.zcode/cli`, realocável via
  `ZCODE_STORAGE_DIR`/`ZCODE_DATA_BASE_DIR`). 🧩
- `-c/--continue` retoma a última sessão do cwd (🧩 help; análogo ao
  `--continue` do claude).

## 10. Tools e modos de permissão

| Modo | Comportamento | Verificação |
| --- | --- | --- |
| `plan` | Somente leitura/análise | ✅ prompts respondidos sem tocar arquivos |
| `build` | Tools de inspeção/execução | ✅ leu `note.txt` via tool `Read` e devolveu o conteúdo |
| `edit` | Edição de arquivos | 🧩 (usado pela factory para workers) |
| `yolo` | Tudo, sem pedir aprovação; **default do `--prompt`** | 🧩 help; factory usa para workers autônomos |

- **Não há como restringir a lista de tools por invocação** na 0.16.5
  (`--allowed-tools`/`--disallowed-tools` são flags fantasma). O modo é o único
  controle. Um driver que precisa de tool policy mecânica (hooks) não a tem —
  é por isso que o driver `zcode` da factory declara `toolPolicy: false` e
  `permissions: false`.
- 🧩 Hooks por projeto existem (`zcode.json`/`.zcode/config.json`, campo
  `hooks`), mas não há superfície por-invocação para injetá-los.

## 11. Structured output

Não há flag de schema/structured output no CLI. 🧩 A camada de providers do
bundle conhece `structuredOutputMode` (`"outputFormat" | "jsonTool" | "auto"`)
via `providerOptions` do config, mas não há como passá-lo por invocação.

Padrão adotado pela factory: **o schema viaja dentro do texto do prompt** (o
driver `zcode` embute o `JUDGE_SCHEMA` quando recebe `options.schema`) e a
validação fica no limite da review (`parseJudge` + re-ask limitado). Funciona:
na run de ponta a ponta o judge `glm-5.3` devolveu o verdict exatamente no
schema. ✅

## 12. Custo/preamble e performance

- Preamble observado (prompt trivial, modo plan): **~15,3–15,5k input tokens**
  por chamada fria, com 2,9–9k de cache read na primeira chamada e ~14,8k ao
  retomar sessão. ✅
- Comparação de mesmo porte: a rota claude-code "dietada" da factory mede
  ~4,3k input/turn. O preamble nativo do ZCode é mais pesado; a vantagem dele
  é protocolo nativo (tool calling no formato do GLM) e independência do shim
  Anthropic-compatível.
- Live metering mid-run é impossível por design (a saída só existe no fim);
  usage só no envelope terminal. ✅

## 13. Quirks conhecidos (0.16.5)

| Quirk | Detalhe | Contorno |
| --- | --- | --- |
| Help desatualizado | `--max-turns`, `--settings`, `--allowed-tools`/`--disallowed-tools` rejeitados pelo parser | Testar toda flag na versão alvo antes de depender |
| Node de sistema quebra | `detached ArrayBuffer` no caminho de resposta (Node 24 x64) | Rodar com o Node do Electron (`ELECTRON_RUN_AS_NODE=1 …/MacOS/ZCode …/zcode.cjs`) |
| Provider `zai` 404 sem login | A rota coding-plan assina requisições; sem `zcode login` ela 404 mesmo com key válida | Provider id neutro (`glm`) + `ZCODE_BASE_URL` |
| `inputTokens` cache-inclusivo | `totalTokens = input + output` | Subtrair `cacheReadTokens` para input frio |
| Sem custo, sem stream, sem schema flag | Envelope único terminal | Parsers orientados a "objeto final + stderr" |
| "Pro" não é modelo | `glm-5.3-pro` → Unknown Model | Usar `glm-5.3` (judge forte) / `glm-5.3-flash` (worker) |

## 14. Como a factory usa (resumo do driver `zcode`)

- Executável: `INTENT_FACTORY_ZCODE_BIN` → `runtime.executable` → `zcode` no
  `PATH` (o shim da seção 2).
- Por invocação o driver injeta: `ZCODE_MODEL=<provider>/<model>`
  (provider de `config.provider`, default `glm`; sufixo `[1m]` removido),
  `ZCODE_BASE_URL` (default `https://api.z.ai/api/anthropic`),
  `<PROVIDER>_API_KEY` com o token da cadeia `auth_token.env_key` →
  `ZAI_API_KEY` → `ANTHROPIC_AUTH_TOKEN`, e remove `ANTHROPIC_API_KEY`
  ambiente (o CLI o testa primeiro).
- `permissionMode` do runtime vira `--mode`; continuação via `--resume sess_…`;
  prompt via `--prompt` (limite argv 128 KB); schema do judge embutido no
  prompt; `structuredOutput`/`toolPolicy` declarados `false` com honestidade.
- Preflight live: o default de 15s é curto para o preamble do ZCode — usar
  `INTENT_FACTORY_PREFLIGHT_TIMEOUT_SEC=60`.
- Exemplo de runtime num contrato:

```json
{
  "zcode-flash": { "driver": "zcode", "model": "glm-5.3-flash", "vendor": "zhipu-flash", "permissionMode": "edit" },
  "zcode-pro":   { "driver": "zcode", "model": "glm-5.3", "vendor": "zhipu-pro", "permissionMode": "plan" }
}
```

Vendors distintos são obrigatórios quando o gate cruza worker × judge da mesma
família (ver `references/contract.md`).
