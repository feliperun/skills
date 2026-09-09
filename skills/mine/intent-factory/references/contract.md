# Contract reference

Node.js 22+, plain ESM `.mjs`; TypeScript is development-only (`npm run
typecheck`). Schema version is `3`.

## Shape

```json
{
  "schemaVersion": 3,
  "contractVersion": "0.1.0",
  "id": "feature-42",
  "campaignId": "feature-42",
  "goal": "Deliver feature 42 with tests",
  "cwd": "../target-repo",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 2400,
  "runtimeDefaults": { "worker": "luna", "judge": "sol" },
  "runtimes": {
    "luna": { "driver": "codex", "model": "gpt-5.6-luna", "reasoning": "xhigh", "fallback": "flash" },
    "flash": { "driver": "codex", "model": "deepseek-v4-flash", "reasoning": "low",
      "config": { "model_provider": "deepseek" } },
    "sol": { "driver": "codex", "model": "gpt-5.6-sol", "reasoning": "xhigh" },
    "opus": { "driver": "claude", "model": "opus", "permissionMode": "acceptEdits" },
    "glm": { "driver": "glm", "model": "glm-5.3[1m]", "config": { "auth_token.env_key": "ZAI_API_KEY" } },
    "agy-flash": { "driver": "agy", "model": "gemini-3.7-flash-low" }
  },
  "nodes": [
    {
      "id": "implementation", "type": "backend", "phase": "implementation",
      "taskPacketFile": "packets/implementation.json", "dependsOn": [], "timeoutSec": 2400,
      "definitionOfDone": [
        { "id": "behavior-implemented", "text": "The requested behavior is implemented",
          "proof": { "kind": "command", "ref": "npm test" } },
        { "id": "diff-scoped", "text": "No unrelated files changed",
          "proof": { "kind": "path", "ref": "src/feature-42.ts" } },
        { "id": "design-honored", "text": "The change honors the stated design decisions", "judgment": true }
      ],
      "gate": { "failOn": ["major", "critical"], "maxRevisions": 1 }
    }
  ]
}
```

Every `definitionOfDone` item declares `id`, `text`, and how it is proven:
`proof.kind` `command` (re-runs the command, capped at `min(timeoutSec, 120s)`)
or `path` (a file must exist), or `judgment: true` for the judge. `proof: {
kind: "verification", ref: <index> }` reuses a `verification` entry's already
recorded result by position instead of re-running it — never by comparing argv
strings, since a joined argv loses shell semantics. A schema-1 string item is
rejected. There is no spend ceiling anywhere in the schema: no
`maxInputTokens`, `maxCostUsd`, or `usagePolicy`. `timeoutSec` and
`stallTimeoutSec` bound an attempt; a spent provider allowance is handled by
runtime re-tiering (below), never a token/dollar cap. `usage.jsonl` records
tokens and cost per invocation for **reporting only** — no control path reads
it.

## Task packets

```json
{
  "mode": "execution",
  "objective": "One concrete outcome",
  "instructions": ["Exact behavior to implement"],
  "readFiles": ["src/feature.ts"],
  "writeFiles": ["src/feature.ts"],
  "symbols": ["runContract"],
  "decisions": ["Decision already made; do not reopen"],
  "nonGoals": ["Explicitly excluded work"],
  "verification": [{ "argv": ["node", "--test", "test/feature.test.mjs"] }]
}
```

`mode` is `execution`, `discovery`, or `autonomous`. `objective`,
`instructions`, and `verification` are required and non-empty. An execution
packet requires non-empty `readFiles` and `writeFiles`; read paths are
relative to `cwd`, cannot escape it, and must exist at validation time. A
discovery packet has empty `writeFiles`; with an empty `readFiles` it may
read the repository read-only to produce an execution packet — the one
exception to closed scope — otherwise it is closed to the listed files. Each
`verification` entry is `{argv, cwd?, timeoutSec? (default 120, max 600),
repeat? (default 1, max 8), env?}` — at most 32 commands, 64 argv items, 32
KiB argv bytes per command. `env` declares variable *names* only; values
never travel in the packet. The legacy `prompt`/`promptFile` fields are
rejected; a node has `taskPacket` or `taskPacketFile`, never both.

An `autonomous` packet declares `writeRoots` instead of `writeFiles`:
whole-repo read, write bounded to the listed files/directories. Scope is
advisory, not a gate: a completed attempt whose worker result and
verification both pass keeps unexpected writes as a `scopeFindings` entry
(shown to the judge and in `status`/`status --json`) and still reaches
`done`; only a failed verification turns the unexpected paths into part of
the failure. Redirect a toolchain's cache/build output under `.runs/`
(git-ignored, outside the snapshot) instead of enumerating generated paths.
The workspace snapshot skips `.runs`, `.git`, `node_modules`, `.claude`,
`.codex` at the repository root.

The stored `contract.json` inlines every packet (dropping `taskPacketFile`
and the generated prompt) and carries a `packetHash` the runner validates on
load, so a run directory is a self-contained resumable record.

## Worker results

```json
{
  "status": "done",
  "summary": "Implemented the described behavior",
  "changedFiles": ["src/feature.ts"],
  "verification": ["node --test test/feature.test.mjs"],
  "artifacts": [],
  "missingContext": []
}
```

`status` is `done` (empty `missingContext`) or `blocked_context` (at least one
`missingContext` entry) — the only response when the closed context is
missing something, never repository-wide exploration. Bounded: 32 KiB total,
4 KiB summary, 32 entries each in `changedFiles`/`verification`/`artifacts`
(16 in `missingContext`), 2 KiB per entry (16 KiB per artifact). Unknown
provider-added fields are dropped; missing/malformed canonical fields are
rejected (`worker-result.mjs`). A discovery node returns `done` with exactly
one `artifacts` entry: the execution packet for the next node.

## Runtimes and routing

Resolve a worker as `nodes[].runtime`, then `runtimeDefaults.worker`; a judge
as `nodes[].gate.runtime`, then `runtimeDefaults.judge`. When `runtimes` and
`runtimeDefaults` are both omitted, the factory composes them from the
installed-driver catalogue: the cheapest available runtime executes, the
strongest runtime of a *different vendor* judges, persisted in
`routing.assignments`; no admissible cross-vendor judge fails by name
(`runtime_assignment_judge_unavailable`).

`driver` is `claude`, `codex`, `agy`, `glm`, `exec-jsonl`, or `replay`.
Vendor is resolved (`resolveVendor` in `drivers/index.mjs`), not the driver
name: an explicit `vendor`, else a provider-config override (a codex runtime
with `config.model_provider: "deepseek"` is vendor `deepseek`), else the
driver default (`claude`→anthropic, `codex`→openai, `agy`→google,
`glm`→zhipu); `replay`/`exec-jsonl` have no default and must declare
`vendor`. Validation rejects a gate-enabled node whose worker and judge
resolve to the same vendor.

- `claude`: `permissionMode` (default `acceptEdits`; a node that runs
  commands needs `bypassPermissions`, since headless `acceptEdits` denies
  execution and the worker can only return `blocked_context`). Executable
  override: `executable` or `INTENT_FACTORY_CLAUDE_BIN`. Claude-compatible
  adapters (`claude`, `glm`) disable slash commands, MCP, and settings files
  on every invocation and restrict tools to `runtime.tools` (default `Read,
  Edit, Write, Bash, Glob, Grep`); `--bare` is never used because it also
  disables the tool-policy hook.
- `codex`: `sandbox` (`read-only`, `workspace-write` default,
  `danger-full-access`); arbitrary `config` entries serialize as `-c
  key=value`; disables browser/computer-use/app/sub-agent tooling and MCP by
  default (`CODEX_PREAMBLE_OVERRIDES`). Executable override: `executable` or
  `INTENT_FACTORY_CODEX_BIN`. Never rely on a profile name to select a custom
  provider — Codex silently accepts unknown profiles.
- `glm`: runs GLM models through a Claude-Code-compatible CLI pinned to the
  Z.ai Anthropic-compatible endpoint; injects `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_AUTH_TOKEN`, strips ambient
  `ANTHROPIC_API_KEY`. Token from `config["auth_token.env_key"]` (default
  `ZAI_API_KEY`). Executable override: `executable` or `INTENT_FACTORY_GLM_BIN`.
- `agy`: the installed `agy` CLI (or `INTENT_FACTORY_AGY_BIN`); optional
  `printTimeout`; omit `reasoning` for models without `--effort`.
- `exec-jsonl`: generic driver for a JSONL-protocol executable — one
  `run.request` on stdin, `run.started`/`message`/`run.completed`/
  `run.failed` on stdout. Set `executable` (or
  `INTENT_FACTORY_EXEC_JSONL_BIN`), `args`, `versionArgs` when `--version` is
  unsupported.
- `replay`: stands in for any provider in tests — recorded, already-normalized
  envelopes, zero model calls. `config["replay.recording"]` names a JSONL
  recording consumed strictly in order via a `.cursor` sidecar; each consumed
  line appends one record to `<recording>.invocations.jsonl`. A missing line
  emits `replay_exhausted` (exit 1); a path escape in `files` emits
  `replay_path_escape` (exit 2) and writes nothing.

Continuation is capability-gated (`codex`, `claude`, `glm`, `agy`,
`exec-jsonl`, `replay` all declare it) and requires an exact fingerprint of
the runtime definition; a runtime change, a failover hop, or an adapter
without the capability starts a fresh session carrying prior structured
summaries forward, never a continuation ID.

### Failover

`runtimes[<id>].fallback` names at most one other runtime id — the single hop
a role takes on provider exhaustion; there is no chain, so a cycle is
structurally impossible and a self-loop is rejected. `tier` groups runtimes
for composed re-tiering (cheaper tiers first); `costRank` breaks ties. A
worker fallback is taken unconditionally once reachable and unattempted this
revision. A judge fallback is admissible only when it differs in vendor from
the worker runtime that actually ran the attempt; a same-vendor fallback is
refused and the node parks `attention` with
`judge_fallback_vendor_conflict`. Either role exhausting its one-hop budget
without an admissible target ends `exhausted` (worker) or `attention` (judge)
with `runtime_tier_exhausted`, preserving any announced `exhaustedUntil`.
Budget, scope, permission, and authority failures never trigger failover.

When an exhaustion envelope announces `resetAt` strictly after now and
strictly before the node's own deadline, the controller waits for it on the
same runtime instead of taking an edge; a reset outside that window, or none
announced, takes the declared/synthesized edge. A wait is not a hop and does
not consume the failover budget.

`doctor --discover [--json]` normalizes each driver's exhaustion signal into
`{available, exhaustedUntil, reason}` (missing CLI → `not_found`; auth
failure has no reset; a quota response keeps its reset, including Z.ai code
1310).

## Graph and states

`dependsOn` forms a DAG; a node starts once every dependency is `done`, and a
failed terminal dependency makes it `blocked`. Terminal states: `done`,
`no-op`, `blocked`, `failed`, `exhausted`, `stalled`, `canceled` — every node
ends in exactly one. `stallTimeoutSec` bounds silence on stdout/stderr;
`timeoutSec` (default 2400s) caps one invocation and may be overridden per
node; a node is bounded by `(1 + maxRevisions) × 2 × timeoutSec`. Both clocks
are monotonic and pause with host suspend. `maxParallel` above 1 dispatches
every dependency-ready node concurrently, each into its own attempt
worktree; integration stays serialized.

## Gates

`gate: false` skips review (`none`). A gate object accepts `runtime`
(judge override), `review` (`none`/`advisory`/`blocking`, default
`advisory`), `failOn` (default `["critical"]`), `maxRevisions` (default 1).
`advisory` records the verdict, findings and `maxSeverity` and still settles
`done` on deterministic verification alone — it never consumes a revision or
re-dispatches. `blocking` re-dispatches within `maxRevisions` when findings
reach `failOn`. Validation requires `critical` whenever `major` is in
`failOn`, and requires `major` in `failOn` for a `blocking` gate — `failOn:
["critical"]` alone lets every major-severity judge finding through
unblocked, which is close to no gate at all.

The revision budget counts gate rejections, not worker starts; a resume or a
crash-restart never consumes one (tracked separately as `attempt` vs.
`revisions`). Deterministic `verification` commands run once by default
before any judge and the judge reviews the recorded results, never
re-running them (`repeat` opts into re-running a flaky check). A judge
output is `pass` only with empty `findings` and `maxSeverity: none`; for
Codex judges, normalization selects the last parseable JSON agent message.
Zero or multiple verdict-shaped messages, a dead judge, or a wall-clock kill
is a review-protocol defect, not a verdict — one bounded re-ask; if that
also fails, advisory review completes `done` with `gate.verdict:
invalid_judge_output`, while blocking review marks the node `blocked` with
`judge_unavailable`, preserving the worker result and verification for
`resume` to re-judge. There is no first-class `stopped` state: model a
falsification gate as a node whose Definition of Done requires a durable
stop artifact and a fail-closed check, and do not schedule descendants after
it is accepted.

## Run artifacts

Under `<cwd>/.runs/<id>/`:

```text
contract.json  run.json  status.json  findings.json
nodes/<id>.json
logs/<id>.<attempt>.<worker|judge>[.r<n>].jsonl / .err
operations/<invocationId>.intent.json / .settlement.json
usage.jsonl  integration.jsonl  events.jsonl  notify.jsonl  STATUS.md
```

`operations/` holds the exact-once intent/settlement record for every
provider invocation, written before dispatch and merged idempotently after:
`settled` means a known driver outcome; `unknown_effect` means the request
may have run without proof and is not permission to retry. Replay of an
unknown-effect window needs `replayPolicy: "safe"` (default) plus a clean
persisted scope across the window and passing verification; otherwise it
settles `reconciled` and blocks the node with `unknown_effect_reconciled` — a
durable manual-stop attention boundary. All writes happen under the
controller lock. `usage.jsonl` is one line per invocation: tokens by kind
(uncached input, cache read, output), `costUsd` with provenance (`provider`,
`priced`, `unknown`), timestamps — reporting only. See
[operations.md](operations.md) for worktrees, integration, `status.json`,
notify, the controller lock, and campaigns.

## Resume

`resume <run-dir>` continues an interrupted run in place: same run, same
node, attempt plus one, packet frozen. It adopts completed work first — a
worker log proving the turn finished recovers an orphaned provider process,
and a node `blocked` with `judge_unavailable` is re-judged from the
preserved result, never re-dispatched to a worker. Only then does it
re-dispatch ordinary failures (`failed`, `stalled`, `canceled`,
wall-clock-`exhausted`, `blocked`/`dependency_failed`) as attempt plus one,
with a bounded `## Previous attempt` section (prior error, judge/scope
findings, failing commands) appended to the regenerated prompt.
`resume --node <id>` limits the retry to that node and its dependents.

`unknown_effect_reconciled` is re-dispatched only with an explicit
`--reconcile <node-id>`. Resume accepts a current `HEAD` that is a
descendant of the recorded `gitHead` (workers and the orchestrator commit
between attempts) and records the new head; a non-descendant is refused. A
`dirtyTreeFingerprint` mismatch is a status warning, not a refusal.

## Environment doctor, cancel, JSON status

`doctor [<contract.json>] [--cwd <dir>] [--json]` is mutation-free: checks
`cwd` is a git work tree, `.runs/` is ignored, `node`/`npm` are on `PATH`,
and — with a contract — every routed driver exists and probes cleanly.
`cancel <run-dir>` signals the controller (`SIGTERM` then `SIGKILL` after
2s), takes over its now-stale lock, terminates every recorded invocation,
and marks the run terminal; it cannot act on a lock held by its own process.
`status --json`/`report --json <run-dir>` emit stable `schemaVersion: 1`
payloads for streaming monitors instead of `STATUS.md`.
