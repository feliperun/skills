# Contract reference

## Shape

```json
{
  "id": "feature-42",
  "campaignId": "feature-42",
  "goal": "Deliver feature 42 with tests",
  "cwd": "../target-repo",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 2400,
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
    "agy-flash": {
      "driver": "agy",
      "model": "gemini-3.7-flash-low"
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
      "sandbox": "danger-full-access",
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
      "id": "implementation",
      "type": "backend",
      "taskPacketFile": "packets/implementation.json",
      "dependsOn": [],
      "timeoutSec": 2400,
      "definitionOfDone": [
        "The requested behavior is implemented",
        "Relevant automated tests pass",
        "No unrelated files changed"
      ],
      "gate": {
        "failOn": ["critical"],
        "maxRevisions": 1
      }
    }
  ]
}
```

Paths are relative to the contract file. `cwd` is the worker's repository. A node must contain exactly one of `taskPacket` (inline JSON) or `taskPacketFile` (a path relative to the contract). The legacy `prompt` and `promptFile` fields are rejected.

## Task packets

A task packet is a JSON object with every field required:

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
  "verification": ["node --test test/feature.test.mjs"]
}
```

`mode` is `execution` or `discovery`. `objective`, `instructions`, and
`verification` must be non-empty; the other fields are arrays and may be empty
where sensible. Execution packets require non-empty `readFiles` and
`writeFiles`. Read paths are relative to `cwd`, cannot escape it, and must exist
at validation time. Write paths are also relative and may name new files.
Discovery packets are read-only: `writeFiles` must be empty, and the generated
prompt requires the worker to return an execution packet rather than edit the
repository. When a discovery packet supplies no `readFiles`, it is the explicit
exception to closed inspection and may read the repository read-only only as
needed to produce that execution packet; otherwise it is closed to the listed
files.

Validation rejects the old `prompt`/`promptFile` fields, malformed packets,
unknown fields, escaping paths, and missing execution read files. The harness
renders a deterministic worker prompt from the packet. Execution prompts state
that the context is closed, limit inspection/edits to the listed paths, and
require `BLOCKED_CONTEXT: <missing file or fact>` instead of repository-wide
exploration. Judges receive the same closed evidence set: inspect only
`writeFiles`, run only the listed `verification`, and do no repository-wide
discovery.

The stored `contract.json` inlines the packet and drops both `taskPacketFile`
and the generated prompt, so `resume` regenerates the same prompt from the
packet. Packets are snapshots, not hashed or sealed in this version; regenerate
the contract when a scoped file changes, and treat the stored contract as the
durable execution record.

## Runtime resolution

Resolve a worker runtime in this order:

1. `nodes[].runtime`
2. first matching `runtimeRules[]` entry
3. `runtimeDefaults.worker`

Resolve judges from `nodes[].gate.runtime`, then `runtimeDefaults.judge`. A rule matches when every key in `match` equals the node field with the same name.

`driver` is `claude`, `codex`, or `agy`. An agy runtime uses the installed `agy`
CLI (or `HARNESS_AGY_BIN`) and may set `printTimeout`; omit `reasoning` for models
that do not accept `--effort`. A Codex runtime may provide arbitrary `config`
entries; the adapter serializes each one as a `-c key=value` override. Store
environment variable names, never secret values.

A Codex runtime may set `sandbox` to `read-only`, `workspace-write`, or
`danger-full-access`; the default is `workspace-write`. Select the least
privilege that completes the task. Package installation and other networked
implementation work requires a sandbox whose environment permits network
access; record that choice in the contract instead of relying on the caller's
ambient sandbox.

## Graph and states

`dependsOn` forms a DAG. A node starts only after every dependency is `done`. A failed terminal dependency makes the node `blocked`.

`stallTimeoutSec` limits silence from stdout and stderr. `timeoutSec` caps a
single provider invocation and may be overridden per node, so a slow worker
never spends the judge's budget; a node is therefore bounded by
`(1 + maxRevisions) × 2 × timeoutSec`. The default is 2400 seconds (40
minutes); set 4800 seconds explicitly for profile-wide or multi-browser nodes.
A node that exhausts its
wall-clock budget is restarted by `resume` with a doubled budget (persisted in
the run's stored contract).

`maxInputTokens` (optional) stops the controller from scheduling new nodes
once the cumulative input tokens across all nodes reach the budget; running
nodes finish, pending ones become `blocked` with `budget_exceeded`.

Both limits are measured on a monotonic clock that does not advance while the
host is suspended. A closed laptop lid pauses a run instead of killing whichever
node happened to be executing, and stall detection uses output mtime only to
notice change, never to measure how long the silence lasted.

Set the stall limit from the selected runtime and phase. Reviewers composing a
long final document may be healthy while emitting no event for several
minutes; use a larger stall window for that bounded phase while retaining a
hard `timeoutSec`. v0 observes byte activity only and cannot distinguish final
composition from deadlock.

Terminal states are `done`, `no-op`, `blocked`, `failed`, `exhausted`, `stalled`, and `canceled`. Every node ends in exactly one.

## Gates

`gate: false` skips review. A gate object enables review and accepts:

- `runtime`: optional judge runtime override.
- `failOn`: severities that cause retry or failure; default `['critical']`.
- `maxRevisions`: retries after the first rejected attempt; default `1`.

The revision budget counts gate rejections, not worker starts. Restarts
produced by `resume` or by orphaned crashes do not consume it: a node that
lost attempts to controller deaths still receives the revision it was
contracted for. The node state records `attempt` (worker starts, used for log
generations) separately from `revisions` (gate rejections consumed).

Findings below the configured threshold remain recorded in node state but are advisory.

Run deterministic repository checks before invoking a judge. Judge output is a
strict JSON object: `pass` is valid only when `findings` is empty and
`maxSeverity` is `none`; any non-empty findings list uses `fail`, even when all
findings are below `failOn` and therefore do not trigger a revision. For Codex
judges, normalization selects the last parseable JSON agent message rather than
an unrelated trailing prose message.

Evidence-producing checks must either use unique temporary/output paths under
concurrency or run serially. Re-run the deterministic command before accepting
the gate to prove idempotence and expose shared-artifact races.

The graph has no domain-level `stopped` state in v0. Model a falsification gate
as a normal node whose Definition of Done requires a durable stop artifact and
a fail-closed repository check. Do not run descendants after the artifact is
accepted; preserve the harness terminal state separately from the product
verdict.

## Run artifacts

The CLI writes under `<cwd>/.runs/<id>/`:

```text
contract.json
run.json
judge.schema.json
nodes/<id>.json
logs/<id>.<attempt>.<worker|judge>[.r<n>].jsonl
logs/<id>.<attempt>.<worker|judge>[.r<n>].err
events.jsonl
STATUS.md
```

Use `STATUS.md` for normal status queries. Read logs only to diagnose an actionable failure. A provider or judge failure preserves the latest worker report in node state so completed work remains inspectable.

The stored `contract.json` inlines every task packet and drops generated
prompts and `taskPacketFile`, so a run directory is a complete resumable
record. A repeated phase never overwrites an earlier log; it takes the next
`.r<n>` generation.

`run.json` holds the controlling process id. `STATUS.md` uses it to separate a
node that is genuinely working from one whose controller died, and names the
orphans instead of reporting them as `running`. A run directory written before
process tracking has no `run.json`; liveness is then unknown and no claim is
made.

## Detached launch

`run --detach <contract.json>` and `resume --detach <run-dir>` fork the
controller into its own process group, print `pid` and run directory, and exit
immediately. The controller survives the invoking session, so a session close
no longer strands a running node as an orphan; the run directory remains the
single source of state and `status`/`resume` work against it the same as ever.
Without `--detach` the controller is a child of the invoking session and dies
with it.

## Resume

`resume <run-dir>` continues an interrupted run from its own directory.

Every node that is not `done` is either adopted or restarted. Adoption reads
the newest worker log of the node's current attempt and keeps the result when
the stream itself proves the turn completed; a gated node is then re-judged
rather than re-implemented, and a node carrying a failed verdict restarts from
the retry prompt. Nodes with no usable worker output return to `pending`.

Adoption is what recovers an orphaned provider process: the control plane can
die while a detached worker keeps writing and finishes, which leaves node state
claiming `running` forever. Resume converts that log into state instead of
paying for the work twice. It does not adopt judge output — only the worker
phase, which is the expensive one.

The stored `contract.json` round-trips through validation on resume: the
internal disabled-gate shape `{"enabled": false}` stays disabled, so a node
without a gate is never silently re-gated by a resume.

## Campaigns

Every contract requires `campaignId`. Campaign state lives at
`.runs/campaigns/<campaign-id>/` and can link multiple runs. Commands stay under
the harness CLI:

```bash
node <skill-dir>/scripts/harness.mjs campaign init <campaign-id> --goal "Goal"
node <skill-dir>/scripts/harness.mjs campaign attach <campaign-id> --tool codex --session-id <session-id> --transcript <absolute-path> --format jsonl [--cursor <cursor>]
node <skill-dir>/scripts/harness.mjs campaign note <campaign-id> --session-id <session-id> --kind <intent|decision|supersede|constraint|outcome|next|open-question> [--decision-id <id> | --supersedes <id> | --run-id <run-id>] --text <text>
node <skill-dir>/scripts/harness.mjs campaign show <campaign-id>
```

Artifacts:

```text
campaign.json
journal.jsonl
HANDOFF.md
```

- `journal.jsonl` is the append-only, fsynced narrative state; `nodes/*.json` remains authoritative for run/node transitions.
- `HANDOFF.md` is an atomic, bounded projection of recent user intents, active decisions, constraints, outcomes, next action, open questions, linked runs, and session/transcript lineage. Entry count is capped and the final file is capped at 16 KiB; the full journal is always preserved.
- `campaign.json` keeps an ordered, idempotent `linkedRunIds` list; `resume` does not append duplicate `run.registered` journal events.
- Handoff rendering refreshes at initialization, run registration, state transitions, explicit `status`, and terminal completion — not on every idle poll.
- Crash recovery can only replay state written to the journal or a transcript/hook/wrapper. State that never reached any durable sink cannot be recovered.
