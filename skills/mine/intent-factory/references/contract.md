# Contract reference

The runner runs on Node.js 22 or newer and CI exercises the current LTS and
current releases. TypeScript is a development-only dependency for
`npm run typecheck`; the runtime is plain ESM `.mjs`.

## Shape

```json
{
  "schemaVersion": 1,
  "contractVersion": "0.1.0",
  "id": "feature-42",
  "campaignId": "feature-42",
  "goal": "Deliver feature 42 with tests",
  "cwd": "../target-repo",
  "maxParallel": 1,
  "stallTimeoutSec": 300,
  "timeoutSec": 2400,
  "usagePolicy": {
    "epoch": "2026-08",
    "maxInputTokens": 900000,
    "judgeReserveInputTokens": 120000,
    "maxPhaseInputTokens": 180000,
    "maxInvocationTokens": 100000,
    "cacheReadWeight": 0.1
  },
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
    "glm": {
      "driver": "glm",
      "model": "glm-5.3[1m]",
      "config": { "auth_token.env_key": "ZAI_API_KEY" }
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
      "phase": "implementation",
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

## Continuity capsule

The continuity kernel's portable handoff is a bounded, redacted, canonical JSON
capsule produced only from a settled checkpoint. Its minimum shape is:

```json
{
  "capsuleVersion": 1,
  "runId": "opaque-id",
  "nodeId": "opaque-id",
  "attemptId": "opaque-id",
  "objective": "The continuing objective",
  "constraints": [],
  "decisions": [],
  "nonGoals": [],
  "changedFiles": [],
  "worktreeIdentity": { "gitHead": "full-sha", "dirty": false },
  "receipts": [],
  "verifications": [],
  "artifacts": [],
  "blockers": [],
  "nextAction": "The next safe action",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadInputTokens": 0 },
  "costUsd": 0,
  "budgetRemaining": 0,
  "continuationHint": null,
  "digest": "lowercase-hex"
}
```

The canonical UTF-8 JSON is at most 16 KiB; the builder never emits a capsule
above the bound and throws when even a fully truncated capsule cannot fit.
`runId`, `nodeId`, and `attemptId` are opaque identity strings; `objective` is
at most 4 KiB, `nextAction` 1 KiB, and `continuationHint` 2 KiB; each
string-list item is at most 1 KiB; receipts, verifications, and artifacts are
capped at 64, 64, and 32 entries. The capsule carries bounded context and
evidence only: no transcripts, logs, binaries, private hosts, recipients,
credentials, authorization headers, or employer-specific relay details.
Reject malformed capsules, unknown top-level fields, and digest mismatches.

Redact before canonicalizing and digesting. Small deterministic rules replace
environment assignments (`KEY=value`), bearer credential schemes, and
high-entropy runs of 32 or more `[A-Za-z0-9_-]` characters that mix letters
and digits with a stable `[redacted]` marker; the rules never read the
building host's environment. Opaque identity fields (`runId`, `nodeId`,
`attemptId`, `gitHead`, artifact `sha256`) are exempt, and free text is
redacted before bounding so a secret cannot be shortened below its detector
threshold first. Compute the lowercase hexadecimal SHA-256 digest over the
canonical redacted JSON with `digest` omitted. Verify the digest before using
a capsule; the digest authenticates the capsule contents, not an external
effect.

Oversize reduction is deterministic and explicit: artifact previews drop
first, then list fields halve, replace items with the truncation marker, or
empty (in artifacts, receipts, verifications, changedFiles, constraints,
decisions, nonGoals, blockers order), then scalar fields shorten or remove
(`continuationHint`, `nextAction`, `gitHead`, usage values, `costUsd`,
`budgetRemaining`, then `objective`). List-field cuts and artifact-preview
drops are flagged with a `*Truncated` boolean, shortened text carries an
inline `…[truncated]` marker, and removed optional scalars become `null`, so a
consumer can see exactly what was bounded.

### Intents and settlements

The intent/settlement lifecycle is:

```text
intent -> executing -> settled
                  \-> unknown_effect -> safe_replay | reconciled
```

Record the intent before dispatch. Each provider invocation reserves a durable
operation record (`operations/<invocationId>.intent.json`) before the provider
process is released: operation and invocation identity, run, campaign, node,
role, phase, attempt, runtime fingerprint, prompt fingerprint, and scope
snapshot reference. The invocation identity written before spawn is the only
identity later accepted for settlement or recovery.

Settlement (`operations/<invocationId>.settlement.json`) is exact-once and
idempotent: the operation keeps its first `settledAt`, merges receipts
(provider continuation/session identity plus prompt, stdout, stderr, and — for
workers — scope-snapshot paths, deduplicated by kind and reference), and never
downgrades a resolved outcome. A preliminary `closed` observation or an
`unknown_effect` may be replaced by the final envelope outcome; a resolved
status is terminal. `settled` requires a known driver outcome; `unknown_effect`
means the request may have run without proof of its outcome and must not be
blindly retried. Replaying an unknown-effect window is gated by the node's
`replayPolicy` (default `safe`): only a clean persisted workspace scope across
the ambiguous window plus passing deterministic controller verification allows
`safe_replay`; anything else settles as `reconciled` and blocks the node with
`unknown_effect_reconciled` — a durable manual-stop boundary for terminal
attention. Reconciliation reuses the same intent and evidence, is idempotent,
and must not create a second intent or invent service evidence.

Cost is independent of effect status and travels as a plain nullable USD
amount (`costUsd`) with the remaining campaign allowance (`budgetRemaining`)
and raw usage token counts. Usage is persisted even when an invocation dies by
kill, timeout, stall, or scope-gate failure; no amount is fabricated or
promoted by a handoff.

All intent, settlement, and capsule writes happen under the controller lease,
so the handoff between controllers is serialized: a second controller is
rejected while a healthy lease is held, and `resume` takes over the lease
before recovering any operation.

## Driver protocol and handoff

Every driver invocation receives the closed task packet, an intent identifier,
an optional portable capsule, and—when supported—an explicit native
continuation handle. It emits one `run.started`, zero or more `message` events,
and exactly one `run.completed` or `run.failed` terminal event. Usage and cost
are included when available; diagnostics go to stderr; protocol output contains
no credentials or private routing data. A failure after dispatch is
`unknown_effect` unless the driver proves that the intent was not run.

Portable context is the correctness boundary. Native continuation is optional,
driver-scoped state and must use the persisted explicit session ID; ambient
most-recent CLI history is never selected. Codex and Claude native sessions are
not interchangeable. A Codex-to-Claude handoff (or the reverse) first settles
the current intent, exports and verifies the capsule, then starts a new native
session from that capsule. Do not hand off from an executing or unknown-effect
checkpoint.

The first release documents only this continuity kernel. Service-driver
adapters, service-specific reconcile lookups, and a transactional store remain
later phases and are not part of this contract.

Paths are relative to the contract file. `cwd` is the worker's repository. A node must contain exactly one of `taskPacket` (inline JSON) or `taskPacketFile` (a path relative to the contract). The legacy `prompt` and `promptFile` fields are rejected.

Every node must declare a non-empty `phase`. Nodes in the same phase must be
ordered by `dependsOn`; this makes one worker continuation and one judge
continuation unambiguous. Keep tasks as small checkpoint nodes. A typical phase
has several sequential implementation nodes and enables its gate on the final
node. Each invocation remains bounded by `timeoutSec`. Reuse also requires an
exact fingerprint of the full runtime definition and resolved executable;
failover or any runtime-setting change rotates to a fresh session. Reuse is also
capability-gated: a runtime whose adapter does not declare `continuation` gets a
deterministic bounded handoff in a fresh session, never a continuation ID or a
reuse marker. A completed invocation without a continuation ID is fresh on the
next node.

The adapter capability matrix is exact:

| driver | continuation | token budget | monetary budget | explicit continuation/budget mechanism |
| --- | --- | --- | --- | --- |
| `codex` | yes | yes | no | persisted session resume; native rollout token budget |
| `claude` | yes | no | yes | `--resume SESSION_ID`; `--max-budget-usd` |
| `glm` | yes | no | yes | `--resume SESSION_ID`; `--max-budget-usd` |
| `agy` | yes | no | no | `--conversation=SESSION_ID`; timeout/accounting fallback |
| `exec-jsonl` | yes | yes | no | protocol `continuationId`; wrapper-enforced `maxInvocationTokens` |

`maxInvocationTokens` is sent only when the routed adapter declares the token
budget capability. `maxCostUsd` is optional command data and is sent only when
the adapter declares monetary-budget enforcement, using the smallest positive
remaining node-level and campaign-level allowance. Providers without a native
in-flight token boundary remain bounded by `timeoutSec` and campaign accounting.
Continuation always uses the persisted explicit session ID; ambient most-recent
CLI history is never selected.

`usagePolicy` is required and is either `false` or an object. Its `epoch` is an
explicit campaign-wide reset key; `maxInputTokens` is the hard weighted
input limit, `judgeReserveInputTokens` is withheld from workers, and
`maxPhaseInputTokens` is a soft context boundary. `maxInvocationTokens` is an
in-flight provider boundary: Codex uses its native weighted rollout budget,
while `exec-jsonl` forwards the value to the wrapper. Claude, GLM, and agy do
not receive this field and remain protected by `timeoutSec`, so choose a short
bounded timeout for them. `cacheReadWeight` controls campaign and phase
budget charging while raw cache reads remain visible; use the provider's current
cached-to-uncached rate ratio. Normalized `inputTokens`
contains uncached input plus cache writes; `cacheReadInputTokens` is separate,
and weighted budget input is `inputTokens + cacheReadInputTokens *
cacheReadWeight`. The campaign ledger is exact-once by epoch and invocation ID, so a
new run ID does not reset the budget. Choose a new epoch deliberately after a
provider/account quota reset. If Codex omits usage when its native rollout
budget stops a turn, the ledger conservatively charges `maxInvocationTokens`.

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
  "verification": [{ "argv": ["node", "--test", "test/feature.test.mjs"] }]
}
```

`mode` is `execution` or `discovery`. `objective`, `instructions`, and
`verification` must be non-empty; the other fields are arrays and may be empty
where sensible. Execution packets require non-empty `readFiles` and
`writeFiles`. Read paths are relative to `cwd`, cannot escape it, and must exist
at validation time. Write paths are also relative and may name new files.
Each `verification` entry is an argv command object: `argv` is required (a
non-empty array of strings, at most 32 commands per packet, 64 argv items and
32 KiB of argv bytes per command), with optional `cwd`, `timeoutSec` (default
120, at most 600), `repeat` (default 1, at most 8), and `env` (declared
environment-variable names; values never travel in the packet).
Discovery packets are read-only: `writeFiles` must be empty, and the generated
prompt requires the worker to return an execution packet rather than edit the
repository. When a discovery packet supplies no `readFiles`, it is the explicit
exception to closed inspection and may read the repository read-only only as
needed to produce that execution packet; otherwise it is closed to the listed
files.

A toolchain that writes caches or build output into the repository (`zig`,
cargo, gradle, …) breaks the closed-scope gate: the controller snapshots the
workspace and fails the node on any undeclared write. Redirect the toolchain's
cache and output directories under `.runs/` (already git-ignored and outside
the workspace snapshot) — for example `zig build --cache-dir .runs/zig-cache
--global-cache-dir .runs/zig-gcache --prefix .runs/zig-out` — instead of
enumerating generated paths in `writeFiles`.

The workspace snapshot skips five directories at the repository root: `.runs`,
`.git`, `node_modules`, `.claude` and `.codex`. The last two are the scratch
state of the agent runtimes the runner itself spawns — a lock file, a todo
list or a shell snapshot written there is the runner's own machinery, never
worker product, and must not fail a node. Nested paths such as
`src/.claude/…` are ordinary files and stay inside the snapshot. Declaring a
`writeFiles` entry under an excluded root is not an error but earns a
validation warning: the gate can neither fail on that write nor prove it
happened.

Validation rejects the old `prompt`/`promptFile` fields, malformed packets,
unknown fields, escaping paths, and missing execution read files. The runner
renders a deterministic worker prompt from the packet. Execution prompts state
that the context is closed, limit inspection/edits to the listed paths, and
require the structured `blocked_context` worker result instead of repository-wide
exploration. Judges receive the same closed evidence set: inspect only
`writeFiles`, run only the listed `verification`, and do no repository-wide
discovery.

The stored `contract.json` inlines the packet and drops both `taskPacketFile`
and the generated prompt, so `resume` regenerates the same prompt from the
packet. Packets carry a `packetHash` that the runner validates on load; regenerate
the contract when a scoped file changes, and treat the stored contract as the
durable execution record.

## Worker results

Every worker ends with exactly one structured worker-result object as the only
content of its final message:

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

`status` is `done` or `blocked_context`. `blocked_context` requires at least
one `missingContext` entry and is the only allowed response when the packet's
closed context is missing a required file or fact — never repository-wide
exploration. `done` requires an empty `missingContext`. The result is bounded:
32 KiB total, 4 KiB summary, at most 32 entries each in `changedFiles`,
`verification`, and `artifacts` (at most 16 in `missingContext`), and per-item
byte caps (2 KiB per changed-file, verification, or missing-context entry,
16 KiB per artifact). Worker and judge output are external LLM boundaries:
unknown provider-added fields are dropped and the canonical fields are kept;
missing or malformed canonical fields are rejected. Judge verdicts follow the
same rule — a model that adds `toolAction` or `confidence` to the verdict
object still gates correctly.
`parseWorkerResult`/`validateWorkerResult` in `worker-result.mjs` enforce the
schema. A discovery node returns `done` with exactly one `artifacts` entry: the
execution task packet for the next node.

## Runtime resolution

Resolve a worker runtime in this order:

1. `nodes[].runtime`
2. first matching `runtimeRules[]` entry
3. `runtimeDefaults.worker`

Resolve judges from `nodes[].gate.runtime`, then `runtimeDefaults.judge`. A rule matches when every key in `match` equals the node field with the same name.

`driver` is `claude`, `codex`, `agy`, `glm`, or `exec-jsonl`. A claude runtime accepts
`permissionMode` (default `acceptEdits`); a node that must execute commands
(builds, tests, smoke scripts) needs `bypassPermissions`, because headless
`acceptEdits` denies every non-trivial command and the worker can only return
`blocked_context`. The default executable is `claude`; override it with
`executable` or `INTENT_FACTORY_CLAUDE_BIN`. An agy runtime uses the
installed `agy` CLI (or `INTENT_FACTORY_AGY_BIN`) and may set `printTimeout`; omit
`reasoning` for models that do not accept `--effort`. A Codex runtime defaults
to the `codex` binary (override with `executable` or `INTENT_FACTORY_CODEX_BIN`)
and may provide arbitrary `config` entries; the adapter serializes each one as a
`-c key=value` override. Store environment variable names, never secret values.

A glm runtime runs GLM models (for example `glm-5.3[1m]`, the 1M-context tier)
through a Claude-Code-compatible CLI pinned to the Z.ai Anthropic-compatible
endpoint, so GLM nodes do not depend on the caller's ambient Anthropic
configuration. The adapter injects `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
and `ANTHROPIC_AUTH_TOKEN` into the worker environment and removes any ambient
`ANTHROPIC_API_KEY`. It resolves the token at invocation time from the variable
named by `config["auth_token.env_key"]` (default `ZAI_API_KEY`, falling back to
`ANTHROPIC_AUTH_TOKEN`); declaring the key in `config` also makes preflight
report a missing credential. The default executable is `claude`; override it
with `executable` or `INTENT_FACTORY_GLM_BIN`. Omit `reasoning` for models that do
not accept `--effort`. The CLI may log an `unrecognized_model` warning on
stderr for models outside its local catalog; the request still goes through
and the result normalizes normally.

`exec-jsonl` is the generic driver for an existing executable that speaks the
JSONL protocol: it receives one `run.request` line on stdin, including
`continuationId` and (when declared) `maxInvocationTokens`, and writes
`run.started`/`message`/`run.completed`/`run.failed` events to stdout, in that
order, with no unknown fields. Set `executable` (or `INTENT_FACTORY_EXEC_JSONL_BIN`)
for the binary, `args` for fixed arguments, and `versionArgs` when it does not
accept `--version`. It supports structured output, continuation, and usage
reporting, but neither monetary-budget enforcement, sandbox, nor permission
negotiation.

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
A node that exhausts its wall-clock budget is restarted by `resume` with the
same bounded invocation timeout. A timeout override is used only when a human
explicitly supplies one; resume never doubles the timeout automatically.

`maxInputTokens` is mandatory on every contract and may be tightened per node.
The controller meters active invocations live from their transcript tails each
poll tick: a node whose observed input tokens pass its own cap is terminated
immediately and labeled `exhausted` with `token_budget_exceeded`; once
cumulative spend (persisted plus live-observed) reaches the contract budget,
every running worker is stopped and pending nodes become `blocked` with
`budget_exceeded`. A budget that cannot stop a running worker is not a budget.
Usage is persisted before scope-gate evaluation, so kills, timeouts, stalls,
and scope failures still report their real token cost — backfilled from the
transcript when a provider died without a terminal usage event (agy and
exec-jsonl only report at completion and meter as zero mid-run).

The usage policy stops new work at the campaign hard maximum while preserving
the judge reserve. A soft phase limit rotates the provider session before the
next node and seeds it with bounded deterministic summaries plus the current
closed task packet; it never blocks the plan.

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
accepted; preserve the runner terminal state separately from the product
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
operations/<invocationId>.intent.json
operations/<invocationId>.settlement.json
capsules/<nodeId>.<attempt>.json
events.jsonl
STATUS.md
findings.json
```

Use `STATUS.md` for normal status queries. Read logs only to diagnose an actionable failure. A provider or judge failure preserves the latest worker report in node state so completed work remains inspectable.
`operations/` holds the exact-once intent and settlement records for every
provider invocation; `capsules/` holds the portable continuation capsule
written at each settled worker boundary. Both are state, not diagnostics.

When a run finishes with any non-done node, the controller writes
`findings.json`: a consolidated snapshot with per-node status, error,
gate findings, `blockedBy`, `missingContext`, and the `unexpectedPaths` that
tripped a closed-scope failure — the single file a triage session reads
instead of loading run state. Nodes remain the source of truth;
a resume that later drives the run fully done removes the artifact.

The stored `contract.json` inlines every task packet and drops generated
prompts and `taskPacketFile`, so a run directory is a complete resumable
record. A repeated phase never overwrites an earlier log; it takes the next
`.r<n>` generation.

`run.json` holds the controlling process id. `STATUS.md` uses it to separate a
node that is genuinely working from one whose controller died, and names the
orphans instead of reporting them as `running`. A run directory written before
process tracking has no `run.json`; liveness is then unknown and no claim is
made.

## Detached launch and waiting discipline

`run --detach <contract.json>` and `resume --detach <run-dir>` fork the
controller into its own process group, print `pid` and run directory, and exit
immediately. The controller survives the invoking session, so a session close
no longer strands a running node as an orphan; the run directory remains the
single source of state and `status`/`resume` work against it the same as ever.
Without `--detach` the controller is a child of the invoking session and dies
with it.

The orchestrator session never waits. No `while`/`sleep` status loops, no
repeated `status` calls, no watched background processes: every tool call
re-sends the whole session context, so a polling loop pays the orchestrator's
full context price on every tick while the controller and supervisor — plain
Node processes — do the same watching for free. Report the run directory, arm
the supervisor, and end the turn. Under a harness that re-invokes the session
continuously (a goal, an autonomous loop, a scheduler), check status at most
once per invocation and act only on terminal states.

One contract covers one whole approved plan step as a batched multi-node DAG
(`dependsOn`), authored in a single turn. Serial single-node contracts keep the
control session active for the entire physical runtime; `validate` warns on a
single-node contract because the only legitimate case is a targeted fix node
after gate exhaustion.

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

## Leases

The run directory holds `controller-lease.json` (and `supervisor-lease.json`
for the supervisor). A lease records holder id, pid, process start token, and
an expiry; the controller renews it on a short TTL while it works. A second
controller or supervisor is rejected while a healthy lease is held, so
simultaneous `resume` calls cannot double-run a node. `STATUS.md` treats a
`running` node as an orphan when the lease is missing, expired, or invalid —
the process is gone, so the node is not live work. `cancel` takes over a stale
lease after confirming the previous controller is dead. The lease also
serializes the handoff: intents, settlements, node transitions, and capsule
writes are made only by the lease holder, so two controllers cannot double-run
or double-settle a node.

## Environment doctor

`doctor [<contract.json>] [--cwd <dir>] [--json]` is mutation-free: it never
writes run state. It checks that `cwd` is a git work tree, that `.runs/` is
git-ignored, that `node` and `npm` are on `PATH`, that the runner protocol and
schema versions are current, and — when a contract is given — that the contract
validates, every routed driver binary exists, and each runtime probes cleanly
against the exact model and capability requirements. Without a contract no
driver is required; binaries are reported as present or absent without failing
the check. Exit code 0 means every check passed. `--json` prints
`{schemaVersion: 1, repo, ok, checks}`.

## Cancel

`cancel <run-dir>` writes `cancel.request.json`, terminates the controller and
every recorded provider and verification process, and marks the run terminal.
A live controller receives `SIGTERM`, then `SIGKILL` if it does not die within
two seconds, and cancellation waits for the lease to expire before taking it
over. Running verification attempts are recorded as canceled with a `SIGTERM`
signal, and any node that is not already terminal is transitioned to `canceled`
instead of being left `running`. Cancel cannot take over a lease held by the
process that invokes it.

## JSON status and report

`status --json <run-dir>` and `report --json <run-dir>` emit stable
`schemaVersion: 1` payloads for streaming monitors: run id, contract and
campaign ids, lease health, per-node status/phase/runtime/attempt/revisions,
and — for report — per-node and total token usage. They never render or write
`STATUS.md`. `events.jsonl` remains the append-only transition stream.

## Campaigns

Every contract requires `campaignId`. Campaign state lives at
`.runs/campaigns/<campaign-id>/` and can link multiple runs. Commands stay under
the runner CLI:

The campaign plan schema, transition table, safety boundary, notification
outbox, and autonomous operational workflow live in
[campaign-autonomy.md](campaign-autonomy.md).
Notifications are controller-only: the controller and the supervisor enqueue
bounded events into the outbox and drain them through the configured generic
executable; the provider protocol carries no notification surface, and live
preflight probes strip the notification executable from their environment.

```bash
node <skill-dir>/scripts/runner.mjs campaign list [--cwd <dir>]
node <skill-dir>/scripts/runner.mjs campaign init <campaign-id> --cwd <dir> --goal "Goal"
node <skill-dir>/scripts/runner.mjs campaign attach <campaign-id> --cwd <dir> --tool codex --session-id <session-id> --transcript <absolute-path> --format jsonl [--cursor <cursor>]
node <skill-dir>/scripts/runner.mjs campaign note <campaign-id> --cwd <dir> --session-id <session-id> --kind <intent|decision|supersede|constraint|outcome|next|open-question|retrospective> [--decision-id <id> | --supersedes <id> | --run-id <run-id>] --text <text>
node <skill-dir>/scripts/runner.mjs campaign resolve <campaign-id> --cwd <dir> --session-id <session-id> --question-id <id> --text <answer>
node <skill-dir>/scripts/runner.mjs campaign watch <campaign-id> --cwd <dir> --cursor session-<session-id>
node <skill-dir>/scripts/runner.mjs campaign watch <campaign-id> --cwd <dir> --since <event-id>
node <skill-dir>/scripts/runner.mjs campaign close <campaign-id> --cwd <dir>
node <skill-dir>/scripts/runner.mjs campaign show <campaign-id> --cwd <dir>
```

`list` discovers active and closed campaigns so a resumed session can pick the
single active one instead of guessing. `resolve` answers an `open-question`
journal event and removes it from the handoff's open-questions section.
`close` marks the campaign terminal; a closed campaign rejects further
attach/note/resolve writes but remains inspectable via `show` and `list`.
`close` refuses until a `retrospective` journal event exists: every campaign
ends with a recorded retrospective (`note --kind retrospective`) that captures
what to improve, so the autonomous completion path leaves the campaign active
until one is recorded.
`watch --cursor` returns ordered unseen notification events and atomically
advances a durable consumer position; invoking it again returns no events until
new material progress exists. `watch --since` is stateless and returns events
after a named event ID that is still retained in the bounded outbox. The flags
are mutually exclusive. A resumed session uses one stable watch consumer ID
derived from its attached session ID and calls `watch` once per reinvocation
before its single status read. This watch consumer ID is unrelated to the
optional transcript position accepted by `campaign attach --cursor`.

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
