# Harness learnings — pdf-wasm-engine plan runs (Aug 12–13, 2026)

What running the full plan (phases C, K, A, V, GVS, F, R, D — 20+ gated nodes)
through the run-harness taught us, in the order it cost us tokens.

## What worked

### DeepSeek worker + deepseek-pro judge is the right default pairing

The user-mandated switch from luna judges to deepseek-pro paid off
immediately: run 003's two nodes passed on attempt 1 with zero revisions,
where luna had burned 17.6M input tokens judging C10 alone. Across the whole
session, deepseek-pro judges passed 14 of 19 gated nodes on the first
verdict; the rest needed one revision each, except two that exhausted.

### Surgical fix nodes beat retry loops — by an order of magnitude

When a node burns its revision budget on gate findings, stop retrying and
write a new single-purpose node: the finding verbatim, the design constraint
that makes the finding legitimate, and the exact files to touch.

| Node | Attempts | Tokens | Outcome |
| --- | --- | --- | --- |
| A00 (retry loop) | 3 | 51.0M | exhausted |
| A01 (fix node) | 1 | 4.5M | pass |
| F01 (retry loop, 2 runs) | 3 | 63.2M | exhausted |
| F01F (fix node) | 1 | 8.7M | pass |

Both fix nodes passed on the first attempt. The retry loop keeps the worker
patching around a design tension it cannot see; the fix node names it.

### resume + orphan adoption handles provider failures cleanly

K03 (stream truncated by `max_output_tokens`) and R00 (transport timeout)
both died provider-side. `resume --detach` restarted each in seconds, the
truncated logs were correctly *not* adopted as results, and the revision
budget was not consumed by the burned attempts (K03's retry passed on its
first gate, revisions still 0). The wall-clock budget is per phase, so a
restarted node gets a fresh worker budget.

### Orchestrator work interleaves safely with a detached run

The complex demos were authored and committed while the F/R/D run was live
in the same working tree. Disjoint paths plus selective staging (`git add
<paths>` only) kept worker work and orchestrator work apart. Gates run full
suites, so any orchestrator addition must be green before it lands — treat
the judge as a lint pass over your own changes too.

### Tooling built mid-session got used mid-session

The `report` command (per-node attempts/revisions/tokens), the rich
`events.jsonl` (attempt, runtime, error code, gate verdict per transition),
and the parallel preflight were written during this session and each one
paid for itself within hours — the report table is where the A00/F01
exhaustion pattern became visible at a glance.

## What bit us

### Uniform wall-clock budgets kill big nodes

F01 and D00 both exhausted at 40 minutes of wall clock *while producing
output* — the stall detector never fired; the budget did. Fix: size
`node.timeoutSec` by node weight (80 minutes for profile-wide or
browser-heavy nodes), and write continuation contracts whose prompt says
"the tree contains the partial work; continue from it" — the continuation
finished in ~20 minutes each time.

### Contract-copy mistakes re-run done work

frd-002 copied the whole frd-001 graph and re-ran the already-green F00
(~8 minutes, 7.8M tokens wasted). When relaunching after an exhaustion,
generate the new contract from the old one with a script that explicitly
prunes the done nodes and rewires `dependsOn` — never hand-edit a copy of
the full graph.

### The most common gate finding is "a required command was not run"

Across F03, R00, and D00 first verdicts, the top rejection reason was that
the worker skipped one of the prompt's command list. Keep node prompts with
an explicit, checkable command list and put every command in the
Definition of Done — the judge then catches the omission mechanically.

### Provider quirks to expect

- DeepSeek streams truncate on `max_output_tokens` mid-work (once per long
  node, roughly) and time out on transport (once per session, roughly).
  Both are handled by resume; don't redesign around them.
- Codex logs a benign `failed to refresh available models` error against
  DeepSeek's `/models` shape (OpenAI-style `models` field missing). It does
  not affect runs.

## Rules of thumb

1. Default 40-minute node budget for small/medium nodes; 80 for profile-wide
   or multi-browser nodes; never let a productive worker die at the cap.
2. After two gate rejections on the same node, stop the loop and write a fix
   node with the finding verbatim.
3. Generate follow-up contracts with a script that prunes done nodes.
4. Explicit command lists in prompts and DoD; gates will enforce them.
5. Commit green phase work between runs; stage paths selectively while a run
   is live.
6. `report <run-dir>` after every terminal run — the token table is the
   cheapest regression detector we have.

## Session numbers

| Run | Nodes | Outcome | Tokens in |
| --- | --- | --- | --- |
| layout-001 (phase K) | 5 | 5 done, 2 revisions | 50.7M |
| final-002 (A fix + V + GVS) | 3 | 3 done | 61.1M |
| frd-003 (F fix + F02–R01) | 8 | 7 done, D00 continuation | 123.1M |
