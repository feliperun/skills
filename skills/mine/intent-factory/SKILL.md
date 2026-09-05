---
name: intent-factory
description: A harness- and model-agnostic development factory that turns plans into verified software changes.
---

# Intent Factory

Run a plan outside the main context while keeping the current session as the
control plane. Store raw worker output under `.runs/`; bring only status and
actionable verdicts into the session.

## Router

| You need | Read |
| --- | --- |
| Contract, packets, results, capsule, driver protocol, states, resume, cancel | [references/contract.md](references/contract.md) |
| Workflow steps, runtime catalogue, adapter capabilities, gates | [references/routing.md](references/routing.md) |
| Campaign plan, transition table, authority, failover routes, commands | [references/campaign-autonomy.md](references/campaign-autonomy.md) |
| Budget profiles, `budgetDecision`/`budgetState` schemas | [references/budget-governance.md](references/budget-governance.md) |
| Status line, notifications, notify transport | [references/feedback.md](references/feedback.md) |
| Harness-side ambient rendering | [references/harness-feedback.md](references/harness-feedback.md) |
| Session save/resume protocol | [references/session-memory.md](references/session-memory.md) |

## Load-bearing rules

**Campaign first.** Establish or discover the durable campaign before launching
work; stop instead of guessing when several are active. Attach this session,
read `HANDOFF.md`, and record every material intent, decision, and open
question as a campaign event: mandatory handoff state, not documentation.

**One contract per approved plan step.** Inspect the repository once, then
author every node of the step with its `dependsOn` edges in a single turn.
Serial micro-contracts keep the expensive control session alive for the whole
physical runtime. Use `mode: "discovery"` only when no packet is possible.

**Closed packets.** Each node lists exact `readFiles`, `writeFiles`, and
`verification`. Workers and judges inspect only those paths and return the
structured `blocked_context` result instead of exploring the repo.

**Preflight before tokens.** `preflight <contract.json>` probes every routed
worker and judge runtime read-only; `doctor` checks the target repo (git work
tree, `.runs/` ignored, node/npm, driver binaries). Then `validate`. Run with
`maxParallel: 1`; concurrency is rejected until filesystem isolation exists, and
the target repo must ignore `.runs/`.

**Detach and supervise.** `run --detach <contract.json>`, then
`supervise --detach <run-dir>`. Both are plain Node processes that outlive this
session; the supervisor re-spawns `resume --detach` whenever the controller
dies before the run is terminal.

**Never wait inside a turn.** No `sleep`/`while` loops, no repeated `status`
calls, no watched background jobs — every tool call re-sends the whole session
context. Check status once per invocation, report one line, end the turn.
Interrupt the user only for `blocked`, `failed`, `exhausted`, `stalled`,
or run completion.

**Resume, do not restart.** A node marked `running` with no runner process is
an orphan. `resume --detach <run-dir>` re-judges finished work instead of
re-implementing it; take a new run id only when routing or the graph changes.

**Gates.** Deterministic argv checks run in the controller before any judge,
which reviews the captured results instead of re-running them. Default `failOn`
to `critical`, set `maxRevisions` explicitly, keep judge and worker runtimes
different. After two rejections or an exhaustion, create one targeted fix node
from the verbatim finding — never copy the graph.

**Budgets.** `maxInputTokens` is mandatory per contract and may be tightened
per node; `usagePolicy` must be an explicit object or `false`. A node over its
cap dies with `token_budget_exceeded`; the contract budget stops every worker
with `budget_exceeded`. A budget stop becomes visible attention within one
supervisor interval — never a silent provider change.

**Foreground children.** Worker prompts run builds, watchers, and servers in
the foreground; only the runner is ever detached. Keep output bounded
(`| tail -n 200`).

## Routing and runtimeRules failover

Express model choice only in `runtimes`, `runtimeDefaults`, `runtimeRules`, or
an explicit node override — never as model-specific branches in orchestration
prose. A worker runtime resolves as `nodes[].runtime`, then the first matching
`runtimeRules[]` entry (a rule matches when every key in its `match` equals the
node field of the same name), then `runtimeDefaults.worker`; a judge resolves as
`nodes[].gate.runtime`, then `runtimeDefaults.judge`.

Failover is not resolution: it lives in the campaign plan's
`authority.runtimeFailover` (`allowedRuntimes` plus `routes` of `from`/`to`). On
provider-reported exhaustion the supervisor walks the outgoing routes of the
resolved runtime in configuration order, resumes on the first edge not yet
attempted, and consumes no gate revision. Once every declared edge is used it stops
at terminal attention with the remaining-edge count
(`provider_exhausted_without_declared_failover`) and requires a human; it never
changes provider or account implicitly. Failover is only for provider
exhaustion; a local budget, scope, or authority stop never rotates runtime.
Failover changes the runtime fingerprint, so it rotates to a fresh
session instead of reusing a continuation.

## Safety

- Node.js 22+ on `PATH`; TypeScript is development-only.
- Keep secrets in env vars; contracts carry variable names only.
- Claude `bypassPermissions` only in a repository-scoped, recoverable
  environment; otherwise keep `acceptEdits` and let denials become `blocked`.
- Never overwrite an existing run directory; choose a new run id.
- One controller lease per run directory; one lease per supervisor.
- Treat `STATUS.md` and node JSON as state; logs are diagnostics.
- Stop and ask before destructive production, data, merge, deployment, or
  credential operations, even if a worker proposes them.
