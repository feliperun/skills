# Contract reference

The runner runs on Node.js 22 or newer and CI exercises the current LTS and
current releases. TypeScript is a development-only dependency for
`npm run typecheck`; the runtime is plain ESM `.mjs`.

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
      "reasoning": "xhigh",
      "fallback": "flash"
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
  "nodes": [
    {
      "id": "implementation",
      "type": "backend",
      "phase": "implementation",
      "taskPacketFile": "packets/implementation.json",
      "dependsOn": [],
      "timeoutSec": 2400,
      "definitionOfDone": [
        {
          "id": "behavior-implemented",
          "text": "The requested behavior is implemented",
          "proof": { "kind": "command", "ref": "npm test" }
        },
        {
          "id": "diff-scoped",
          "text": "No unrelated files changed",
          "proof": { "kind": "path", "ref": "src/feature-42.ts" }
        },
        {
          "id": "design-honored",
          "text": "The change honors the stated design decisions",
          "judgment": true
        }
      ],
      "gate": {
        "failOn": ["critical"],
        "maxRevisions": 1
      }
    }
  ]
}
```

Every `definitionOfDone` item is an object declaring `id`, `text`, and how it
is proven: either `proof` with `kind` `command` or `path` plus a `ref`, or
`judgment: true` for a judge-assessed criterion. A schema-1 string item is
rejected.

## Intents and settlements

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
amount (`costUsd`) alongside raw usage token counts. Usage is persisted even
when an invocation dies by kill, timeout, stall, or scope-gate failure; no
amount is fabricated. Usage is a reporting record only, in `<run-dir>/usage.jsonl`
— one line per worker or judge invocation with its tokens by kind and cost
provenance — and no control path reads it to gate work.

All intent and settlement writes happen under the controller lock, so a
takeover between controllers is serialized: a second controller is rejected
while a live lock is held, and `resume` takes over the lock before recovering
any operation.

## Driver protocol

Every driver invocation receives the closed task packet, an intent identifier,
and—when supported—an explicit native continuation handle. It emits one
`run.started`, zero or more `message` events, and exactly one `run.completed`
or `run.failed` terminal event. Usage and cost are included when available;
diagnostics go to stderr; protocol output contains no credentials or private
routing data. A failure after dispatch is `unknown_effect` unless the driver
proves that the intent was not run.

Native continuation is optional, driver-scoped state and must use the
persisted explicit session ID; ambient most-recent CLI history is never
selected. Codex and Claude native sessions are not interchangeable, so a
runtime change between two phase-sibling nodes never resumes the prior
session: the fresh attempt carries the prior nodes' structured summaries
forward in its prompt instead (see phase reuse below). Do not adopt a session
from an executing or unknown-effect checkpoint.

Service-driver adapters, service-specific reconcile lookups, and a
transactional store remain later phases and are not part of this contract.

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

The adapter continuation matrix is exact:

| driver | continuation | explicit continuation mechanism |
| --- | --- | --- |
| `codex` | yes | persisted session resume |
| `claude` | yes | `--resume SESSION_ID` |
| `glm` | yes | `--resume SESSION_ID` |
| `agy` | yes | `--conversation=SESSION_ID` |
| `exec-jsonl` | yes | protocol `continuationId` |
| `replay` | yes | recorded, not enforced: `--continuation` |

Continuation always uses the persisted explicit session ID; ambient
most-recent CLI history is never selected. There is no spend ceiling of any
kind: `timeoutSec` and `stallTimeoutSec` bound an attempt, and a spent
provider allowance is handled by runtime discovery re-tiering (rule 8), not by
a token or dollar cap the operator had to guess. Usage recorded per invocation
in `usage.jsonl` is a reporting record only.

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

An `autonomous` packet declares `writeRoots` instead of `writeFiles`: whole-repo
read, write bounded to the listed directories. A `writeRoots` entry that names an
existing regular file authorizes exactly that path; a directory entry covers
itself and everything beneath it. Scope is a review concern, not a gate: an
attempt whose worker result and controller verification both pass keeps its
unexpected writes as an advisory finding (`scopeFindings`, shown to the judge and
as the node note in `STATUS.md` and `status --json`) and reaches `done`
exactly as a clean attempt would; only a failed verification turns unexpected
writes into part of the failure.

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
2. `runtimeDefaults.worker`

Resolve judges from `nodes[].gate.runtime`, then `runtimeDefaults.judge`.

Both `runtimes` and `runtimeDefaults` may be omitted. The factory then uses
the installed-driver catalogue and composes omitted roles from available
runtimes: the cheapest runtime works and the strongest runtime from a
different vendor judges. The composed pair is persisted in
`routing.assignments`; explicit node and default declarations are unchanged.
If no admissible judge exists, assignment fails with the named
`runtime_assignment_judge_unavailable` error.

### Vendor identity

Vendor is a resolved property, never the driver name: `resolveVendor` in
`drivers/index.mjs` returns an explicit `vendor` field outright, then a
provider-configuration override (a codex runtime whose `config.model_provider`
is `deepseek` is a deepseek vendor, not `openai`), then the driver's own
default (`claude` → `anthropic`, `codex` → `openai`, `agy` → `google`, `glm` →
`zhipu`). `replay` and `exec-jsonl` have no default — either driver stands in
for whatever the recording or the exec'd binary actually is, so a contract
using either must declare `vendor` outright. A runtime for which nothing above
names a vendor is a validation error naming the runtime.

Validation rejects a gate-enabled node whose worker and judge runtime resolve
to the same vendor, naming both runtimes and the shared vendor — the same
vendor grading its own output is not an independent review.

`driver` is `claude`, `codex`, `agy`, `glm`, `exec-jsonl`, or `replay`. A claude runtime accepts
`permissionMode` (default `acceptEdits`); a node that must execute commands
(builds, tests, smoke scripts) needs `bypassPermissions`, because headless
`acceptEdits` denies every non-trivial command and the worker can only return
`blocked_context`. The default executable is `claude`; override it with
`executable` or `INTENT_FACTORY_CLAUDE_BIN`. Claude-compatible adapters
(`claude`, `glm`) bound the harness preamble on every invocation: no skills
(`--disable-slash-commands`), no MCP servers (`--strict-mcp-config`), no
settings files (`--setting-sources ""`; the explicit `--settings` that carries
the tool-policy hooks still applies) and only the built-in tools named by the
runtime's `tools` list (default `Read, Edit, Write, Bash, Glob, Grep`). With the
ambient configuration a trivial glm-5.3 call cost 65,170 uncached input tokens;
bounded, about 4,300 per turn. `--bare` is never used because it disables
hooks and with them the mechanical tool policy. An agy runtime uses the
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
`continuationId`, and writes
`run.started`/`message`/`run.completed`/`run.failed` events to stdout, in that
order, with no unknown fields. Set `executable` (or `INTENT_FACTORY_EXEC_JSONL_BIN`)
for the binary, `args` for fixed arguments, and `versionArgs` when it does not
accept `--version`. It supports structured output, continuation, and usage
reporting, but neither sandbox nor permission negotiation.

### Replay driver

`replay` stands in for any provider in tests and evals: it emits recorded,
already-normalized envelopes with zero model invocations, so controller
behaviour (gates, resume, failover) is exercised deterministically
after provider normalization. The default executable is the sibling
`scripts/drivers/replay-bin.mjs`; override it with `executable` or
`INTENT_FACTORY_REPLAY_BIN`.

```json
{
  "driver": "replay",
  "model": "<label>",
  "config": { "replay.recording": "<path to a JSONL recording, absolute or relative to the process cwd>" }
}
```

Lines are consumed strictly in order through a `<recording>.cursor` sidecar
(a missing cursor means 0); the live preflight prompt
(`INTENT_FACTORY_PREFLIGHT_OK`) is answered synthetically and never consumes
the recording. Each consumed line appends one record with `at`, `index`,
`promptBytes`, and `args` to `<recording>.invocations.jsonl`. Recording line
schema:

```json
{
  "envelope": { "status": "done", "result": "<text>", "continuationId": null, "usage": { "inputTokens": 1, "outputTokens": 1, "cacheReadInputTokens": 0 }, "costUsd": null, "error": null },
  "files": [{ "path": "out/file.txt", "content": "<text>" }],
  "delayMs": 0,
  "exitCode": 0,
  "stdoutRaw": "<text>"
}
```

`envelope` is an already-normalized provider envelope: `status` is `done`,
`no-op`, `blocked`, `failed`, `exhausted`, `stalled`, or `canceled`, with
canonical `result`, `continuationId`, `usage`, `costUsd`, and `error` fields.
`files` entries are written relative to the run workspace only after
containment checks (relative paths only, no `..` segment, no metadata root
such as `.git`/`.runs`/`node_modules`/`.claude`/`.codex`, and no outward
symlink); a violation emits a `replay_path_escape` failed envelope, writes
nothing, leaves the cursor untouched, and exits 2. A missing line at the
cursor emits `replay_exhausted` and exits 1. `delayMs` (milliseconds) delays
before emitting, `stdoutRaw` replaces the envelope verbatim for
protocol-failure tests, and `exitCode` sets the process exit status.

A Codex runtime may set `sandbox` to `read-only`, `workspace-write`, or
`danger-full-access`; the default is `workspace-write`. The adapter also bounds
the Codex preamble on every invocation by disabling browser, computer-use, app,
code-mode host and sub-agent tooling, MCP servers and plugins
(`CODEX_PREAMBLE_OVERRIDES` in `drivers/codex.mjs`), emitted before the
runtime's own `config` entries so a contract can re-enable any of them. Measured
with deepseek-v4-flash on 2026-09-01: 63,914 input tokens per trivial call with
the ambient configuration, 12,653 bounded. Select the least
privilege that completes the task. Package installation and other networked
implementation work requires a sandbox whose environment permits network
access; record that choice in the contract instead of relying on the caller's
ambient sandbox.

### Failover edges

`runtimes[<id>].fallback` names at most one other runtime id: the single hop
a role takes out of `<id>` when its provider exhausts. There is no chain and
no synthesized ordering over the rest of the contract — the reachable set out
of a runtime is exactly itself and, if declared, its one `fallback`. Because a
hop is bounded at one, a multi-runtime cycle is structurally impossible, and
validation still rejects a self-loop (`fallback` naming the runtime itself).
`tier` groups runtimes eligible for composed re-tiering; lower tiers are
cheaper and higher tiers are stronger. `costRank` breaks ties within a tier.

This one-hop reachable-state enumeration — a node's role, the runtime it
started on, and the runtime named by that runtime's `fallback` — is what
preflight walks: every runtime a run might actually occupy is
capability-checked before the first provider spends anything, and nothing
beyond it. A chain like `A.fallback = B`, `B.fallback = C` never has preflight
probe `C` for a node assigned `A`: that node can take only one hop, so its
reachable set stops at `B`.

A worker fallback is taken unconditionally once its runtime is reachable and
not already attempted this revision. A judge fallback is different: whether it
is admissible depends on which worker runtime actually ran the attempt, which
a static contract cannot know, so it is not a validation error — it is
resolved at routing time. `opus` may replace `sol` judging a Luna or GLM
worker attempt, never a Sonnet worker attempt whose fallback landed on `opus`'s
own vendor; when a judge fallback would share the vendor of the worker runtime
that actually ran, the node is refused that fallback and parked `attention`
with `judge_fallback_vendor_conflict` rather than quietly arbitrated by the
vendor it is supposed to check.

Both roles stay bounded by the existing guards — a runtime already attempted
in the revision, or a hop past the one-hop cap, ends the node `exhausted`
(worker) or `attention` (judge) instead of routing again.

Composed assignments re-tier only within the current tier. A judge candidate
must differ from the vendor of the worker runtime that actually ran. Explicit
single-hop fallbacks take precedence; budget, scope, permission, and authority
failures never switch providers. If no composed candidate remains, the node
enters attention with `runtime_tier_exhausted` and preserves the provider's
`exhaustedUntil` when one was announced.

**Quota reset before an edge.** When the exhaustion envelope announces a reset
instant (`resetAt`, at the envelope root or on its `error`), the controller
weighs it against a window bounded at both ends: strictly after now, and
strictly before the node's own wall-clock deadline (its start plus its
invocation timeout). Inside that window the wait is cheaper than any hop, so
the phase is rescheduled on the runtime it already warmed, with the backoff
running to exactly that instant, and no edge is taken.

Both bounds are load-bearing. A reset at or *after* the deadline would have the
node sit out its whole budget and die waiting. A reset at or *before* now buys
no wait at all: honouring it would park the phase on a zero-length backoff and
re-invoke the exhausted runtime immediately, so a provider that keeps repeating
a stale instant would hot-loop on it. Outside the window — and for an envelope
with no announced reset, or an unparseable one — the run takes its declared or
synthesized edge instead.

A reset retry is not a hop. The hop count is strictly the failover budget, and
a wait spends no runtime, so it is recorded at the hop the phase already had.
Charging it would let a wait consume the budget a later real edge needs: in a
two-runtime contract, whose cap is 2, one charged wait would push the following
genuine edge to the cap and end the node `exhausted` before its second runtime
was ever tried.

## Graph and states

`dependsOn` forms a DAG. A node starts only after every dependency is `done`. A failed terminal dependency makes the node `blocked`.

`stallTimeoutSec` limits silence from stdout and stderr. `timeoutSec` caps a
single provider invocation and may be overridden per node, so a slow worker
never spends the judge's time; a node is therefore bounded by
`(1 + maxRevisions) × 2 × timeoutSec`. The default is 2400 seconds (40
minutes); set 4800 seconds explicitly for profile-wide or multi-browser nodes.
A node that exhausts its wall-clock timeout is restarted by `resume` with the
same bounded invocation timeout. A timeout override is used only when a human
explicitly supplies one; resume never doubles the timeout automatically.

The timeout clock is monotonic and does not advance while the host is
suspended. A closed laptop lid pauses a run instead of killing whichever node
happened to be executing, and stall detection uses output mtime only to
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
- `review`: `none`, `advisory` or `blocking`; omitted is `advisory`, and
  `gate: false` is `none`.
- `failOn`: severities that cause retry or failure; default `['critical']`.
- `maxRevisions`: retries after the first rejected attempt; default `1`.

The revision budget counts gate rejections, not worker starts. Restarts
produced by `resume` or by orphaned crashes do not consume it: a node that
lost attempts to controller deaths still receives the revision it was
contracted for. The node state records `attempt` (worker starts, used for log
generations) separately from `revisions` (gate rejections consumed).

`review` decides what a verdict can do to the node. `advisory` — the default —
records the verdict, its findings and `maxSeverity`, appends a `gate.advisory`
event, and still settles `done` on the node's deterministic verification: it
never consumes a revision and never re-dispatches the worker, and findings
below the threshold are advisory exactly as before. `blocking` is the previous
behaviour, findings at or above `failOn` re-dispatching the node within
`maxRevisions`. `none` never dispatches a judge and settles the checklist
mechanically. Validation keeps a blocking review honest: a `blocking` gate
whose `failOn` omits `major` is rejected, because it could never reject a
major, and any `failOn` listing `major` without `critical` is rejected too,
because the gate tests exact membership and would let a critical through.

Run deterministic repository checks before invoking a judge. Judge output is a
strict JSON object: `pass` is valid only when `findings` is empty and
`maxSeverity` is `none`; any non-empty findings list uses `fail`, even when all
findings are below `failOn` and therefore do not trigger a revision. For Codex
judges, normalization selects the last parseable JSON agent message rather than
an unrelated trailing prose message, and counts the verdict-shaped agent
messages it saw: a judge that returned two of them, or none, or that died
before its terminal envelope, or that was killed on its wall clock, is a
review-protocol defect, not a verdict. One defect earns one bounded re-ask, the
same machinery an uncited rejection spends. When the re-ask fails too, advisory
review completes the node `done` with `gate.verdict` `invalid_judge_output` and
an attention note, while blocking review marks the node `blocked` with
`judge_unavailable` and leaves the accepted worker result, the verification
records and the gate state on disk exactly as they are for a node awaiting its
judge, so `resume` re-judges the work instead of re-running it. Blocking review
never silently passes, and a review that never arbitrated never fails a node
whose verification passed.

Evidence-producing checks must either use unique temporary/output paths under
concurrency or run serially. Re-run the deterministic command before accepting
the gate to prove idempotence and expose shared-artifact races.

The graph has no domain-level `stopped` state in v0. Model a falsification gate
as a normal node whose Definition of Done requires a durable stop artifact and
a fail-closed repository check. Do not run descendants after the artifact is
accepted; preserve the runner terminal state separately from the product
verdict.

## What a gate costs, and what it will not see

Three properties of the gate are load-bearing and each one has cost a campaign
a node in the field.

**A command proof is executed, not declared.** `proof: {kind: "command"}` runs
the command again at gate time, under a ceiling of the node's `timeoutSec`
capped at 120 seconds. Declaring `npm test` or a full workspace build as a
proof therefore runs it a second time and will exceed that ceiling on a cold
tree. Point a command proof at the narrow check that proves the item, and let
the contract-level `finalVerification` carry the expensive suite — it runs
from the controller, outside the worker sandbox and outside that cap.

**A proof that names a verification entry runs nothing.**
`proof: {kind: "verification", ref: 0}` reuses the result the controller
already recorded for that `verification` command on this attempt — pass or
fail, with its output — so an item proven by the node's own verification costs
no second execution. The reference is positional, and it is never recovered by
comparing command strings: a joined argv loses argument boundaries and shell
semantics, so `printf %s 'value; false'` exits 0 as an argv and 1 as a shell
string. `command` proofs still execute and still pay the ceiling above.

**`failOn: ["critical"]` is close to no gate at all.** A judge working at
`major` — which is what the ones used here do — will fail a node repeatedly
without ever reaching `critical`, so with `failOn: ["critical"]` every one of
those findings is advisory and the node reaches `done`. Two independent
campaigns hit this: one approved nine majors in a single phase, the other
shipped a fail-closed regression that had been described in a major. Use
`failOn: ["major"]` unless there is a stated reason not to; validation now
rejects a `blocking` gate without `major` in `failOn`, and any `failOn` that
lists `major` without `critical`.

**A worker reads only inside the worktree.** The `claude` driver passes no
`--add-dir`, and no contract field grants one, so an instruction naming an
absolute path outside `cwd` silently produces nothing — the worker scans, the
read fails, and the node proceeds on whatever it inferred. Embed the text the
node must read in the packet itself rather than pointing at a path outside the
repository.

**The scope gate will not fail a green attempt over an undeclared write.**
Enumerating every path a task touches is the hardest part of authoring a
packet, and it is done once at plan time with no feedback; an attempt whose
worker result and controller verification both pass keeps that mismatch as an
advisory `scopeFindings` entry instead of a terminal `unexpected_write`. Only
a failed verification still turns the same unexpected paths into part of the
error. The finding is not cosmetic: the judge prompt gains a `Scope findings`
section listing the paths, and `STATUS.md` and `status --json` lead the node
note with `scope: N unexpected paths` (the JSON also carries the paths as
`scopeFindings`). Do not rely on the scope gate to catch a change outside the
packet's intent — that is now the judge's job, not the controller's.

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
usage.jsonl
integration.jsonl
events.jsonl
STATUS.md
findings.json
```

Use `STATUS.md` for normal status queries. Read logs only to diagnose an actionable failure. A provider or judge failure preserves the latest worker report in node state so completed work remains inspectable.
`operations/` holds the exact-once intent and settlement records for every
provider invocation; both are state, not diagnostics. `usage.jsonl` holds one
reporting record per worker or judge invocation — runId, nodeId, attempt,
role, runtime id and model, tokens by kind (uncached input, cache read,
output; null when unknown), `costUsd` with provenance (`provider`, `priced`
or `unknown`), and `startedAt`/`finishedAt` — appended at each settled
invocation. It is read by `status`, `report`, `metrics`, the dashboard, and
the status line; no control path reads it.

### Attempt worktrees and integration

Every worker attempt gets a linked worktree at
`.runs/worktrees/<run-id>/<node-id>.<attempt>` on branch
`if/<run-id>/<node-id>/<attempt>`. The branch starts at the explicit run ref
`refs/intent-factory/<run-id>/run`, created at the recorded source `gitHead`.
The node snapshot records `worktree.path`, `worktree.branch`,
`worktree.baseSha`, and the sealed `worktree.commit`. Provider processes,
scope snapshots, controller verification, and judges use that path;
`contract.cwd` remains the home of the run and control artifacts. A Codex-shaped worker writes its result to the attempt's
`.runs/results/<node>.json`; the controller copies it into the canonical run
directory after the process closes.

Completion is a journalled transaction in `integration.jsonl`. The controller
seals the branch, records the attempt SHA, previous run-ref tip, candidate SHA,
and verification evidence, then verifies the candidate through the scratch
worktree `.runs/worktrees/<run-id>/.candidate`. Only a passing candidate moves
the run ref with a conditional `update-ref`; the one done-state write then
records `integratedHead`. Failed verification removes only the candidate
artifacts and keeps the attempt worktree. Merge conflicts block the node with
the conflicting paths and keep the attempt worktree. Resume replays the
unfinished journal record, including an accepted no-change candidate, and
re-drives terminal cleanup and the node event idempotently.

When a run finishes with any non-done node, the controller writes
`findings.json`: a consolidated snapshot with per-node status, error,
gate findings, `blockedBy`, `missingContext`, and the `unexpectedPaths` of an
attempt whose scope violation coincided with a failed verification — the
single file a triage session reads instead of loading run state. A scope
violation on an attempt whose verification passed is not a failure: it never
appears in `findings.json`, only as `scopeFindings` on the done node. Nodes
remain the source of truth; a resume that later drives the run fully done
removes the artifact.

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
full context price on every tick while the controller — a plain Node process
— does the same watching for free. Report the run directory and end the turn;
if the controller later dies, `resume --detach` takes over the stale lock and
adopts or restarts whatever it left running. Under a harness that re-invokes
the session continuously (a goal, an autonomous loop, a scheduler), check
status at most once per invocation and act only on terminal states.

One contract covers one whole approved plan step as a batched multi-node DAG
(`dependsOn`), authored in a single turn. Serial single-node contracts keep the
control session active for the entire physical runtime; a single-node contract
is otherwise simply valid, and `validate` does not warn on it.

## Resume

`resume <run-dir>` continues an interrupted run from its own directory. A retry
is the same run and the same node, attempt plus one, with the failure attached;
the packet is frozen per run and never changes.

Resume adopts completed work first. Adoption reads the newest worker log of the
node's current attempt and keeps the result when the stream itself proves the
turn completed, which is what recovers an orphaned provider process: the
control plane can die while a detached worker keeps writing and finishes,
leaving node state claiming `running` forever. A node `blocked` with
`judge_unavailable` — an accepted worker result and verification records on
disk, review unresolved — is re-judged from that preserved result and is never
reset to `pending` or re-dispatched to a worker.

Only then does resume re-dispatch ordinary failures. A node `failed`,
`stalled`, `canceled`, exhausted by wall clock, or `blocked` with
`dependency_failed` returns to `pending` and is dispatched as attempt plus one
— attempt is the worker-start counter; revisions, the gate-rejection counter,
is not reset. A node blocked with `dependency_failed` becomes pending only
once the dependency it waited on is itself retried; otherwise it keeps its
boundary and resume reports it as attention. `resume --node <id>` limits the
retry to that node and the nodes that transitively depend on it.

The regenerated worker prompt for a retried attempt appends a bounded
`## Previous attempt` section: the prior error code and message, judge
findings, scope findings if present, and the failing verification commands
with a bounded output tail. The judge prompt for that attempt carries the same
section under the same heading.

Two states are stop boundaries that only an explicit flag crosses. A node
`blocked` with `unknown_effect_reconciled` is re-dispatched only when resume is
given `--reconcile <node-id>`, which records the acknowledgement in
`events.jsonl`; without it resume lists the node as attention and leaves it
untouched.

Resume accepts a current `HEAD` that is a descendant of the recorded `gitHead`
— workers and the orchestrator commit between attempts, so a retry in place
expects the branch to have moved on — and records the new head; a
non-descendant `HEAD` is still refused as drift. A `dirtyTreeFingerprint`
mismatch is only a warning surfaced in status, not a refusal, for the same
reason.

The stored `contract.json` round-trips through validation on resume: the
internal disabled-gate shape `{"enabled": false}` stays disabled, so a node
without a gate is never silently re-gated by a resume.

## Controller lock

The run directory holds `controller.lock`: pid, process start token, when
the holder started, and its hostname. There is no TTL and nothing to renew —
a lock stays valid for as long as its holder is alive, however long that
takes. A second `resume` (or `run`) is rejected while a live lock is held, so
simultaneous invocations cannot double-run a node. A contender treats the
lock as stale only once it can prove the holder dead: the recorded pid is
gone, or its process start token no longer matches (the pid was recycled).
`STATUS.md` treats a `running` node as an orphan whenever the lock is
missing, stale, or invalid — the controller is gone, so the node is not live
work. Before a takeover dispatches anything, `resume`'s recovery pass
terminates every recorded provider and verification process for each
formerly-running node (the same list `cancel` uses) and waits for it to
exit, so a detached invocation the dead controller lost track of is reaped
before any new work starts. `cancel` takes over a stale lock after
confirming the previous controller is dead. The lock also serializes the
handoff: intents, settlements, and node transitions are made only by the
lock holder, so two controllers cannot double-run or double-settle a node.
See [operations.md](operations.md) for the takeover sequence in detail.

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
two seconds; once it is dead its lock is stale by construction, so cancel takes
it over immediately, with no expiry to wait out. Running verification attempts
are recorded as canceled with a `SIGTERM` signal, and any node that is not
already terminal is transitioned to `canceled` instead of being left `running`.
Cancel cannot take over a lock held by the process that invokes it.

## JSON status and report

`status --json <run-dir>` and `report --json <run-dir>` emit stable
`schemaVersion: 1` payloads for streaming monitors: run id, contract and
campaign ids, controller lock state (`active`, `stale`, or `none`), per-node
status/phase/runtime/attempt/revisions, and — for report — per-node and total
token usage. They never render or write `STATUS.md`. `events.jsonl` remains
the append-only transition stream.

## Campaigns

Every contract requires `campaignId`. Campaign state lives at
`.runs/campaigns/<campaign-id>/` and can link multiple runs. Commands stay under
the runner CLI:

Notifications are controller-only (rule 6): on `node.terminal`, `run.terminal`
and `attention` the controller calls `INTENT_FACTORY_NOTIFY_BIN` and appends a
receipt to the run's `notify.jsonl`; the provider protocol carries no
notification surface, and live preflight probes strip the notification
executable from their environment. Details:
[operations.md](operations.md).

```bash
node <skill-dir>/scripts/runner.mjs campaign list [--cwd <dir>]
node <skill-dir>/scripts/runner.mjs campaign init <campaign-id> --cwd <dir> --goal "Goal"
node <skill-dir>/scripts/runner.mjs campaign attach <campaign-id> --cwd <dir> --tool codex --session-id <session-id> --transcript <absolute-path> --format jsonl [--cursor <cursor>]
node <skill-dir>/scripts/runner.mjs campaign note <campaign-id> --cwd <dir> --session-id <session-id> --kind <intent|decision|supersede|constraint|outcome|next|open-question|retrospective> [--decision-id <id> | --supersedes <id> | --run-id <run-id>] --text <text>
node <skill-dir>/scripts/runner.mjs campaign resolve <campaign-id> --cwd <dir> --session-id <session-id> --question-id <id> --text <answer>
node <skill-dir>/scripts/runner.mjs campaign sync <campaign-id> --cwd <dir> --session-id <session-id>
node <skill-dir>/scripts/runner.mjs campaign ack <campaign-id> --cwd <dir> --session-id <session-id> --event-id <event-id>
node <skill-dir>/scripts/runner.mjs campaign watch <campaign-id> --cwd <dir> --wake
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
`sync` is the user-initiated read: it prints the campaign header, the newest
linked run's `status.json` summary, and unseen journal events after the
session's durable cursor without ever moving it. `ack` is the only cursor
writer, keyed by the journal's own event id. `watch --wake` is the persistent
poll: it reads every linked run's `status.json` every 30 seconds and prints
one line per actionable change — a run gone terminal, a node in attention, a
non-terminal run whose controller lock is stale, or twenty idle minutes — and
exits once the campaign is closed.

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
