# POC — multi-model loop harness

Status: **executed, including DeepSeek follow-up**
Date: 2026-08-10

## Purpose

Falsify six cheap hypotheses before building a multi-model execution harness.
The POC produces measurements, not production code. Anything that survives the
gate is reusable, but nothing here is committed to the harness by default.

## Background

Prior art studied: [compozy](https://github.com/compozy/compozy) (MIT), specifically
`internal/loop/dsl/`. Four patterns adopted:

| Pattern | Source | Why |
| --- | --- | --- |
| `RuntimeSpec{provider, model, reasoning}` | `dsl/runtime.go` | Model routing as data, not code |
| Separate `worker` / `judge` defaults | `dsl/runtime.go` | Executor and verifier are different roles |
| Contract carries DoD + budget + caps | `dsl/contract.go` | A loop that cannot run forever |
| Closed terminal vocabulary (7 states) | `dsl/contract.go` | Makes the event filter correct by construction |

Explicitly **not** adopted: the daemon. State lives in files.

## Terminal states

`done` · `no-op` · `blocked` · `failed` · `exhausted` · `stalled` · `canceled`

Every node reaches exactly one. The event emitter must emit on all seven —
a filter that only matches success is silent during a hang, and silence is
indistinguishable from progress.

## Hypotheses

Each hypothesis has an explicit death signal. A dead hypothesis is a successful
POC outcome, not a failure.

**H1 — Uniform dispatch.**
`claude -p` and `codex exec` fit behind one `dispatch / poll / collect` interface
with comparable result shapes.
*Dies if* the gate needs provider-specific branching to read a result.

**H2 — Declarative routing.**
A `match{type} → runtime{provider, model, reasoning}` table covers all node types
with no imperative logic in the orchestrator.
*Dies if* a conditional is needed by the third case.

**H3 — Cross-model gate.**
A judge (GPT-5.6 Sol) evaluates worker output against `definition_of_done` and
emits a trustworthy structured verdict.
*Dies if* it approves work a human would reject, or loops rejecting indefinitely.

**H4 — Stall detection.**
`timeout` plus a no-progress window catches a hung worker.
*Dies if* it cannot separate "thinking" from "stuck".

**H5 — Orchestrator context stays flat.**
Running the full epic costs the main session only verdicts and paths.
*Dies if* orchestration exceeds ~15k tokens.

**H6 — The session can be the control plane.**
A complete epic consumes under ~5k tokens of session context, with status pulled
via `/btw` (overlay, not persisted to history) and only actionable transitions
pushed as notifications.
*Dies if* raw logs must be opened more than once per epic to understand state.

## Control surfaces

| Direction | Surface | Cost |
| --- | --- | --- |
| Pull — on demand | `/btw` reads the rendered `STATUS.md` | zero (overlay, not in history) |
| Push — needs a decision | Monitor emits on terminal transitions | ~1 line per transition |
| Deep failure | subagent reads the log, returns a diagnosis | isolated, on demand |
| Process liveness | `/tasks` (built in) | zero |

No TUI, no HTML, no separate terminal. `STATUS.md` is re-rendered by the
background watcher on every transition, so reading it never costs computation
in the session.

## Run layout

```
.runs/<epic-id>/
  contract.json      goal, definition_of_done, budget, caps, routing table
  nodes/<id>.json    one per node: status, runtime, timings, result path, verdict
  events.jsonl       one line per transition
  STATUS.md          pre-rendered table, read by /btw
  logs/<id>.log      raw worker output, never read by the orchestrator
```

## Routing table

```yaml
runtime_defaults:
  worker: { driver: codex, model: gpt-5.6-luna, reasoning: xhigh }
  judge:  { driver: codex, model: gpt-5.6-sol,  reasoning: xhigh }

runtime_rules:
  - match: { type: frontend }
    runtime: { driver: claude, model: opus }
  - match: { type: mechanic }
    runtime: { driver: codex, provider: deepseek, model: deepseek-v4-flash }
```

Provider adapters map a `RuntimeSpec` to a command:

- `claude` → `claude -p --model <model> --output-format stream-json`
- `codex` → `codex exec --json -c <resolved runtime> [--output-schema <file>]`

The Codex adapter supplies provider, model, and reasoning as `-c` overrides and
verifies the resulting stream. Codex 0.147.0 silently accepts unknown profiles,
and provider tables in config files were not applied reliably in this POC.

## Epic under test

Four nodes, deliberately different in nature. Dogfooding: what survives the gate
is a piece of the harness itself.

| Node | Type | Runtime | Deliverable |
| --- | --- | --- | --- |
| A / emitter | frontend | claude / opus-5 | State renderer: `STATUS.md` layout + which transitions become push events |
| B / dispatcher | backend | codex / gpt-5.6-luna : xhigh | `dispatch / poll / collect` across both providers |
| C / parser | mechanic | codex / Luna low, then DeepSeek Flash | Frontmatter parser for spec files |
| D / review | gate | codex / gpt-5.6-sol : xhigh | Verdict for A, B, C against the DoD |

Edges: `A, B, C → D`. A, B and C are independent and run concurrently.

Node A is typed `frontend` because the work is presentation judgment — column
choice, what fits one line, how to show blocking and dependency, which
transition deserves to interrupt the operator. That judgment is what justifies
the expensive model, not the output format.

## DeepSeek follow-up

The original node C used Luna low because the DeepSeek key was not exported.
After the main run, the existing key was exported and the same node was rerun
through Codex with every provider setting supplied as `-c`.

The negative control failed with `Missing environment variable:
DEEPSEEK_API_KEY`. The positive run returned DeepSeek's own model catalog,
produced the parser, passed 18 tests, and passed both adversarial cases that the
Sol gate found in the Luna implementation.

## Out of scope

Daemon, durable persistence, parallel `git worktree`, cross-run memory, resume.
None of it is designed until the six hypotheses are measured.

## Cost

Estimated under $2 in worker tokens. Actual original-run spend was about $3.81
plus the gate; the Opus node dominated. The DeepSeek follow-up did not report a
dollar cost.
