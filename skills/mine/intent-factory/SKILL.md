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
| Contract, packets, results, capsule, driver protocol, states, resume | [contract.md](references/contract.md) |
| Workflow steps, runtime catalogue, adapter capabilities, gates | [routing.md](references/routing.md) |
| Campaign plan, transition table, authority, failover routes, commands | [campaign-autonomy.md](references/campaign-autonomy.md) |
| Heartbeat, outbox, sync/ack, judge gate, prune, metrics, resilience | [release-1.md](references/release-1.md) |
| Budget profiles, `budgetDecision`/`budgetState` schemas | [budget-governance.md](references/budget-governance.md) |
| Status line, notifications, notify transport | [feedback.md](references/feedback.md) |
| Harness-side ambient rendering | [harness-feedback.md](references/harness-feedback.md) |
| Session save/resume protocol | [session-memory.md](references/session-memory.md) |

## Session commands

Everything else runs detached.

| You want | Run |
| --- | --- |
| Probe runtimes and host before spending tokens | `preflight <contract.json>`, `doctor [--cwd <dir>]` |
| Pull unseen campaign events | `campaign sync <id> --cwd <repo> --session-id <s>` |
| Advance that cursor past an event | `campaign ack <id> --cwd <repo> --session-id <s> --event-id <e>` |
| Read the campaign indicators | `metrics <campaign-id> [--cwd <dir>] [--json]` |
| Continue a partly finished run | `contract prune <run-dir> --out <file> [--targeted-fix]` |

## Load-bearing rules

**Campaign first.** Establish or discover the durable campaign before launching
work; stop instead of guessing when several are active. Attach this session,
read `HANDOFF.md`, and record every material intent, decision, and open
question as a campaign event — handoff state, not documentation.

**One contract per approved plan step.** Inspect the repository once, then
author every node of the step with its `dependsOn` edges in a single turn.
Serial micro-contracts keep the expensive control session alive for the whole
physical runtime. Use `mode: "discovery"` only when no packet is possible.

**Closed packets.** Each node lists exact `readFiles`, `writeFiles`, and
`verification`. Workers and judges inspect only those paths and return the
structured `blocked_context` result instead of exploring.

**Prove mechanically.** Every Definition of Done item is an object declaring
its own proof: a verification `command`, a workspace `path`, or `judgment`.
Proofs gate before any judge runs, so a fully mechanical node costs no judge.
Contract-level `finalVerification` runs on the phase-terminal node.

**Detach and supervise.** `run --detach <contract.json>`, then
`supervise --detach <run-dir>`: plain Node processes that outlive this session,
the supervisor re-spawning `resume --detach` whenever the controller dies
before the run is terminal. Run with `maxParallel: 1`; concurrency is rejected
until filesystem isolation exists, and the target repo must ignore `.runs/`.

**Never wait inside a turn.** No `sleep`/`while` loops, no repeated `status`
calls, no watched background jobs — every tool call re-sends the whole session
context. Check status once per invocation, report one line, end the turn.
Interrupt the user only for `blocked`, `failed`, `exhausted`, `stalled`, or
completion.

**Resume, do not restart.** A node marked `running` with no runner process is
an orphan. `resume --detach <run-dir>` re-judges finished work instead of
re-implementing it; take a new run id only when routing or the graph changes.

**Gates.** The judge reviews captured results instead of re-running them.
Default `failOn` to `critical`, set `maxRevisions` explicitly, keep judge and
worker runtimes different. After two rejections or an exhaustion, create one
targeted fix node from the verbatim finding — never copy the graph.

**Budgets.** `maxInputTokens` is mandatory per contract and may be tightened
per node; `usagePolicy` must be an explicit object or `false`. A node over its
cap dies with `token_budget_exceeded`, the contract budget stops every worker
with `budget_exceeded`, and either becomes visible attention within one
supervisor interval — never a silent provider change.

**Foreground children.** Worker prompts run builds, watchers, and servers in
the foreground; only the runner is detached. Keep output bounded
(`| tail -n 200`).

## Routing and runtimeRules failover

Express model choice only in `runtimes`, `runtimeDefaults`, `runtimeRules`, or
an explicit node override — never as model-specific branches in prose. A worker
resolves as `nodes[].runtime`, then the first matching `runtimeRules[]` entry,
then `runtimeDefaults.worker`; a judge as `nodes[].gate.runtime`, then
`runtimeDefaults.judge`.

Failover is not resolution: it lives in the campaign plan's
`authority.runtimeFailover` and only provider exhaustion triggers it — a local
budget, scope, or authority stop never rotates runtime. Routes:
[campaign-autonomy.md](references/campaign-autonomy.md). Synthesis:
[release-1.md](references/release-1.md).

## Safety

- Node.js 22+ on `PATH`; TypeScript is development-only.
- Keep secrets in env vars; contracts carry variable names only.
- Claude `bypassPermissions` only in a repository-scoped, recoverable
  environment; otherwise `acceptEdits`, letting denials become `blocked`.
- Never overwrite an existing run directory; choose a new run id.
- One controller lease per run directory; one lease per supervisor.
- Treat `STATUS.md` and node JSON as state; logs are diagnostics.
- Stop and ask before destructive production, data, merge, deployment, or
  credential operations, even if a worker proposes them.
