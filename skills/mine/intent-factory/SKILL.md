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
| Contract shape, packets, driver protocol, runtimes, gates, worker results, resume | [contract.md](references/contract.md) |
| Worktrees, integration, controller lock, status.json, notify, dashboard, campaigns | [operations.md](references/operations.md) |

## Session commands

Everything else runs detached.

| You want | Run |
| --- | --- |
| Probe runtimes and host before spending tokens | `preflight <contract.json>`, `doctor [--cwd <dir>]` |
| Prove each verification command fits its own `timeoutSec` | `preflight <contract.json> --time-verification` |
| Pull unseen campaign events | `campaign sync <id> --cwd <repo> --session-id <s>` |
| Advance that cursor past an event | `campaign ack <id> --cwd <repo> --session-id <s> --event-id <e>` |
| Wake only on actionable change, poll every 30s | `campaign watch <id> --cwd <repo> --wake` |
| Read the campaign indicators | `metrics <campaign-id> [--cwd <dir>] [--json]` |

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

**Detach and resume.** `run --detach <contract.json>` forks a controller that
outlives this session; if it dies before the run is terminal, the next
`resume --detach <run-dir>` takes over its stale lock and adopts or restarts
whatever it left running. `maxParallel` above one dispatches every ready node
concurrently, each in its own attempt worktree; integration stays serialized.
The target repo must ignore `.runs/`.

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

**No spend ceiling.** `timeoutSec` and `stallTimeoutSec` bound an attempt;
there is no `maxInputTokens`, `maxCostUsd`, or `usagePolicy`. A spent provider
allowance is handled by discovery (rule 8), never a ceiling the operator had
to guess. Usage is recorded per attempt in `usage.jsonl` for reporting only.

**Foreground children.** Worker prompts run builds, watchers, and servers in
the foreground; only the runner is detached. Keep output bounded
(`| tail -n 200`). Never instruct a worker to run a command slower than its
own tool's foreground timeout, including the full test suite — that is what
`taskPacket.verification` is for, run by the controller after the worker
declares done. Measure a verification command's real duration before setting
its `timeoutSec`; a suite can silently outgrow the 600s per-entry cap as it
grows, and a worker forced to wait past its own timeout backgrounds the
command and returns prose instead of a result — a protocol failure, not a
`done`.

## Routing and fallback

Express model choice only in `runtimes`, `runtimeDefaults`, or an explicit
node override — never as model-specific branches in prose. A worker resolves
as `nodes[].runtime`, then `runtimeDefaults.worker`; a judge as
`nodes[].gate.runtime`, then `runtimeDefaults.judge`.

Each runtime may declare one `fallback` runtime id. Only provider exhaustion
takes that single hop — a scope or authority stop never rotates runtime — and
a worker/fallback pair is admissible only when the judge keeps a different
resolved `vendor`. Details: [contract.md](references/contract.md).

## Safety

- Node.js 22+ on `PATH`; TypeScript is development-only.
- Keep secrets in env vars; contracts carry variable names only.
- Claude `bypassPermissions` only in a repository-scoped, recoverable
  environment; otherwise `acceptEdits`, letting denials become `blocked`.
- Never overwrite an existing run directory; choose a new run id.
- One controller lock per run directory.
- Treat `STATUS.md` and node JSON as state; logs are diagnostics.
- Stop and ask before destructive production, data, merge, deployment, or
  credential operations, even if a worker proposes them.
