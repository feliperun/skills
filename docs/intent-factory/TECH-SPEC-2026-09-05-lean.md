# Intent Factory v0.3 "lean": tech spec and campaign plan

Status: revision 2 after adversarial review round 1 (gpt-6-astra, section 10).
Campaign: `intent-factory-lean-20260905`. Base: `campaign/phase-2-base` at
`36c55f6` (release 0.2.0). Worker runtimes: `claude-sonnet-5`, `gpt-5.6-luna`
(xhigh), `glm-5.3[1m]`. Judges: `gpt-5.6-sol` (medium), `claude-opus-5`.

## 0. Measured state of release 0.2.0

Source: `.runs/campaigns/intent-factory-efficiency-20260901/` (ledger,
journal, 49 run directories) and `runner.mjs metrics` over the same data.

| Indicator | Value |
|---|---|
| Runs / nodes | 49 / 129 |
| Nodes done | 29 (22 %) |
| Nodes blocked | 84, of which 60 `dependency_failed` (cascade) |
| Nodes failed / exhausted / stalled | 7 / 8 / 1 |
| Nodes killed by budget accounting (`budget_exceeded` + `budget_attention`) | 21 (16 %) |
| Packet-authoring defects (unique incidents, retrospective 09-05) | 7, surfacing as 4 `unexpected_write` and 5 `context_missing` errors; 2 more from a peer campaign |
| Judge verdicts pass / fail (blocking gates) | 14 / 24; `firstPassGateRate` for `sol-medium` 0.5 |
| Provider invocations (worker / judge) | 72 / 40 |
| Weighted input tokens | 40.7 M across 10 ledger epochs |
| Recorded cost | USD 69.68, Claude only; codex and Z.ai invocations record `costUsd: null` |
| Wall clock | 4 days; 3.67 h per closed checkpoint; 2.04 linked runs per closed checkpoint |
| Journal | 497 events, 278 of them `liveness` |
| Notification outbox | 99 events never delivered (no transport configured) |
| Code | 24,859 production `.mjs` lines in the skill (48 k with tests); `runner.mjs` 6,997 lines against a CI ceiling of 6,998 |
| Full suite | 556 tests, 554 pass, 2 skipped, 9 min 32 s |
| Docs inside the skill folder | 132 KB references + 48 KB spec + 2 addenda + 3 retrospectives + 1 PRD |

Three retrospectives in nine days (08-28, 09-01, 09-05) each added machinery.
Each following campaign then failed in ways that machinery created: a token
cap comparing raw against weighted tokens blocked all four phase-0 nodes;
session rotation fired on turn one; the judge reserve trapped a finished
worker; a lease check-then-delete produced a four-controller storm; a line
ceiling boxed a worker into raising the ceiling; a fixture instruction
contradicted the packet scope; ten ledger epochs were opened because the
ledger allows one policy per epoch. Several of those defects were fixed in
0.2.0 (the cap, the rotation trigger, the reserve, the lease fence); what
remains is the design that keeps producing them.

Hypothesis, not measurement: the 08-28 retrospective compared the factory's
estimate for three nodes (about two hours plus three judges) with three direct
Sonnet agents that finished in parallel in 45 minutes under operator
verification. The comparison is against an estimate and is recorded here as
the motivating hypothesis for rules 1, 2 and 4, to be tested by this campaign.

## 1. Conceptual errors

1. **Scope is enumerated before execution.** A packet must list every file
   the worker reads and writes. Enumerating them perfectly is the hardest part
   of the task, it is done by the most expensive model at plan time with no
   feedback, and it produced seven unique authoring defects in one campaign
   plus two in a peer campaign (a root lockfile rewritten by the toolchain, a
   dossier outside the worktree silently unreadable). Every established coding
   agent gives the agent the whole repository in an isolated workspace and
   reviews the resulting diff.
2. **The judge is a blocking gate on every node with judgment items.** 0.2.0
   already skips the judge when a node has no judgment item; in practice every
   node had several. Blocking gates passed first time in half the attempts,
   stalled or emitted multiple terminal messages in three of five phase-4
   attempts, a `failOn: ["critical"]` trap approved nine majors, Sol judged
   Sol, and a reserve mechanism exists to keep the judge alive. Established
   practice: the deterministic suite is the gate; model review is advisory
   and attaches to the diff; a human merges. A blocking judge did catch one
   real defect the tests missed (the lease race), so blocking review must
   remain available and must never silently degrade.
3. **Token accounting is the control variable.** Four caps
   (`maxInputTokens`, `judgeReserveInputTokens`, `maxPhaseInputTokens`,
   `maxInvocationTokens`), a synthetic unit (`cacheReadWeight` 0.1), epochs,
   derived allocations, segments, continuations, provenance and a capsule
   format. It killed 16 % of nodes, and two thirds of invocations record no
   cost at all. Established practice: one budget per task in money or turns,
   enforced by the provider flag, spend reported after the fact.
4. **A retry is a new run.** A failed node became a new contract, a new run id
   and often a new epoch: 49 runs for roughly 30 logical nodes, each re-authored
   by the orchestrator session. `resume` refuses a `gitHead` descendant, so it
   cannot be used after a worker commits, and `contract prune` was built to
   cope. Established practice: re-run the failed job in place, same identity,
   attempt plus one, with the failure attached.
5. **Distributed-systems machinery on one laptop.** Fenced leases with
   generations, a supervisor lease, heartbeat cache, liveness journal, outbox
   with delivery and pull cursors, an event projector, a 425-line POSIX status
   line parser. The properties they protect are real (one writer per run,
   stale-controller detection, no lost notification) and are kept; the
   machinery is not the smallest thing that provides them.
6. **The factory rebuilds itself while workers edit the runner.** Fifteen
   controller snapshots, rule 15, and every runner regression blocks the
   campaign that is fixing it. Unavoidable for this repository, so the plan
   minimises the window: each phase ships one committed runner that the next
   phase runs on, never the tree being edited.
7. **Rules and documents grew instead of shrinking.** Eighteen load-bearing
   rules; the skill folder, which is installed into other repositories, carries
   200 KB of specs, addenda and retrospectives; every packet repeats the same
   three boilerplate instructions.
8. **Line-count ratchets stand in for modularity.** They boxed two nodes into
   defeat and `runner.mjs` sits one line under its ceiling. Modules are split
   by responsibility when touched; a reviewer judges size.
9. **Flash models on core runner code (hypothesis).** `deepseek-v4-flash`
   closed 2 of 15 nodes; after the switch to Opus the same node classes closed
   first time, but corrected packets and inherited edits confound the
   comparison. The plan routes runner internals to Sonnet and Luna and leaf
   work to GLM, and measures first-attempt success per runtime.
10. **Visibility answers the wrong questions.** The dashboard shows weighted
    tokens, epochs, decisions, intents, constraints, a 496-entry feed and 99
    undeliverable notifications. The operator's questions are: is anything
    running, does anything need me, what did it cost, what changed.
11. **Repeated context and repeated verification dominate token cost.** The
    08-28 retrospective measured cache reads (the transcript re-read every
    turn) at over 95 % of spend and workers running whole suites several
    times per node; this campaign cut one read set from 980 KB to 154 KB and
    still re-runs the same commands as worker verification, controller
    verification and gate proof. Whole-repository access does not reduce
    this by itself; bounded hints, bounded output and a single verification
    run per attempt do.

## 2. Market comparison

| Product | Workspace | Gate | Review | Retry | Budget | Visibility |
|---|---|---|---|---|---|---|
| OpenAI Codex cloud | whole repo in a sealed container | the repo's own tests, run by the agent | diff + command log on a PR, human merges | ask for changes on the same task | per-task limits | task list, live log, diff |
| GitHub Copilot coding agent | whole repo in an Actions runner | CI on the draft PR (human-approved) | PR review comments, agent iterates | same PR, new commits | Actions minutes / premium requests | PR timeline, session log |
| Cursor / Devin cloud agents | whole repo in a VM, branch | tests the agent runs | PR | same session | USD spend limit / ACUs | session list, status, PR link |
| Anthropic long-running harness | whole repo, git as checkpoint | tests; "clean state" at session end | none built in | next session reads progress file | turns per session | progress file, feature list JSON |
| GitHub Actions / Temporal | job per step | exit code | none | re-run failed jobs / activity retry policy, same run id | timeout per step | one page per run: steps, durations, logs |
| **Intent Factory 0.2.0** | closed file list | judge + proofs per node | blocking judge | new run + new contract | 4 token caps, weighted | 3-column dump of every artifact |

The consistent pattern is: whole repository in isolation, deterministic
verification as the gate, review of the diff afterwards, retry in place, one
budget number, one page per run with steps and logs. v0.3 adopts it.

## 3. Target architecture

Seven rules replace the eighteen.

1. **Whole repo, own branch and worktree per attempt.** Every attempt runs in
   `git worktree add .runs/worktrees/<run>/<node>.<attempt>` on branch
   `if/<run>/<node>/<attempt>` created from the run's recorded integration
   head. The packet says what to achieve and what proves it; file hints stay
   (bounded, they cut context), but they are hints, never a fence. The diff is
   the scope record: unexpected paths on a completed attempt are a finding,
   never a terminal state. Ambiguous-effect, result-materialization and
   snapshot-integrity safeguards stay as they are.
2. **Verification is the gate.** A node is `done` when its `verification`
   commands pass on its worktree, the attempt branch is integrated (rule 1
   below), and the integrated candidate passes the same verification. Review
   is `none`, `advisory` (default: findings recorded, node still done) or
   `blocking` (findings at or above the threshold re-dispatch the node,
   bounded by `maxRevisions`). A judge that does not return exactly one valid
   verdict gets one bounded re-ask; after that, advisory review completes
   with the findings it has and `invalid_judge_output` recorded, while
   blocking review enters `attention` with the completed work preserved:
   `resume` re-judges it (with the declared fallback judge when the primary
   is exhausted) or the operator reconciles explicitly. Blocking never
   degrades silently. `failOn` is a set today; validation requires `critical`
   whenever `major` is listed, and blocking review requires `major`.
3. **One budget each.** `maxCostUsd` per node and per run, `timeoutSec` per
   node. Cost comes from the provider when it reports it, else from usage
   times the `pricing` table declared on the runtime (input, output, cache
   read per million); an invocation with no usage is recorded as `unknown`
   and counted separately. Nothing else is metered for control; usage is
   recorded per attempt in `usage.jsonl` for reporting.
4. **Retry in place.** `resume <run-dir>` first adopts and re-judges completed
   work: orphaned running nodes as today, and also nodes whose worker result
   and verification are recorded but whose review is unresolved (`blocked`
   with `judge_unavailable`) — those are re-judged, never re-dispatched to a
   worker. Then it re-dispatches ordinary failures (`failed`, `stalled`,
   `exhausted` by timeout, `canceled`, and `blocked` by `dependency_failed`)
   as attempt plus one with the previous error and findings appended, in a
   fresh worktree from the integration head. `unknown_effect_reconciled`
   stays a stop boundary: it is retried only after an explicit
   `--reconcile <node>` acknowledgement. An exhausted run budget is reported
   as attention and retried only with an explicit `--max-cost-usd` (or, on
   0.2.0, `--max-input-tokens`) extension recorded in the run. A run id lives
   as long as its goal; instructions are frozen per run; a correction is a
   new run.
5. **One controller, an atomic lock, files as state.** `run --detach` starts
   one controller that acquires `controller.lock` by atomic exclusive create,
   recording pid and process start time; a contender treats the lock as
   stale only when the pid is dead or its start time differs. Workers and
   verification run in their own detached process groups, so a takeover
   first terminates every invocation process group the dead controller
   recorded in node state (the same list `cancel` uses), waits for them to
   exit, and only then dispatches anything; a test proves an orphaned
   invocation is reaped. Status shows a stale controller explicitly. Node
   JSON and `events.jsonl` are the state; `status.json` per run and
   `.runs/status.json` (pointer to the active run) are derived each tick for
   readers. No supervisor lease, heartbeat, liveness journal, outbox,
   projector or generation fencing.
6. **Notify with receipts, session pulls.** On `node.terminal`,
   `run.terminal` and `attention` the controller calls
   `INTENT_FACTORY_NOTIFY_BIN` with a one-line message and appends a receipt
   (`delivered` or `failed`, with the timestamp) to `notify.jsonl`; a failed
   delivery is retried on the next ticks up to three times with backoff. The
   control session reads `campaign sync` (journal event ids as the cursor)
   when it wakes; nothing wakes it.
7. **Docs fit in one sitting.** `SKILL.md` ≤ 6 KB, `references/contract.md`
   ≤ 20 KB, `references/operations.md` ≤ 10 KB. History lives under
   `docs/intent-factory/`.

**Integration transaction (rule 1 and 2 detail).** Integration is serialized
by the controller: it creates the candidate `integration-head + attempt
branch` on the run branch (fast-forward or merge), runs the node's
`verification` on the candidate, and then performs exactly one state write:
the node JSON becomes `done` carrying `integratedHead` (the candidate sha).
The integration head is never persisted separately; it is derived on read as
the run branch tip, which must equal the newest `integratedHead` among done
nodes, and dependents are scheduled only from done nodes. The single crash
window is therefore "merged but not written": on startup the controller
detects an attempt branch already contained in the run branch
(`git merge-base --is-ancestor`), re-verifies the candidate and performs the
same write idempotently. A conflict marks the node `attention` with the
conflicting paths and keeps the attempt worktree for inspection; nothing is
auto-resolved. Tests cover a crash after the merge and before the write, and
a repeated integration producing no duplicate effect.

**Verification once per attempt (error 11).** The worker is told to run the
targeted checks it needs; the controller runs `verification` once on the
worktree and once on the integrated candidate. A Definition-of-Done item may
declare `proof: {kind: "verification", ref: <index>}`, which names a
`verification` entry by position and reuses its recorded result (pass or
fail and output) at gate time; `command` proofs always execute. Reuse is by
reference only, never by comparing command strings, because a joined argv
does not preserve argument boundaries or shell semantics. The judge sees the
recorded results.

Modules after v0.3 (line budgets are review guidance, not CI ceilings):

| Module | Role | Target |
|---|---|---|
| `runner.mjs` | CLI only | ≤ 300 |
| `scheduler.mjs` | DAG, slots, retry in place | ≤ 400 |
| `node.mjs` | one attempt: worktree, prompt, worker, verification, review | ≤ 700 |
| `integrate.mjs` | integration transaction, conflicts | ≤ 250 |
| `lock.mjs` | atomic controller lock, stale detection, takeover | ≤ 120 |
| `contract.mjs` | schema 3 validation | ≤ 600 |
| `verification.mjs` | commands, output bounds, snapshot integrity | ≤ 400 |
| `review.mjs` | judge prompt, verdict candidates, re-ask | ≤ 300 |
| `drivers/protocol.mjs` | shared normalization and version parsing (extracted from `exec-jsonl.mjs`) | as today |
| `drivers/*` | claude, codex, glm, agy, replay | as today |
| `campaign.mjs` | journal, HANDOFF, sync/ack on journal ids, close-with-retrospective | ≤ 500 |
| `metrics.mjs` | indicators over attempts, USD, active time | ≤ 400 |
| `notify/*` | one-line dispatcher, receipts, bounded retry, adapters | ≤ 200 |
| `dashboard/*` | server ≤ 300, page ≤ 450 | |
| `statusline/claude-code.sh` | read `.runs/status.json` | ≤ 40 |

Deleted, each only after its readers have been adapted in the same phase:
`budget.mjs`, `heartbeat.mjs`, `outbox.mjs`, `events.mjs`, `capsule.mjs`,
`campaign-autonomy.mjs` (unused by the last campaign: no `plan.json` or
`control-state.json` exists), `supervisor.mjs` (folded into the controller),
`lease-liveness.mjs`, the generic adapter half of `drivers/exec-jsonl.mjs`
(the shared utilities every driver imports move to `drivers/protocol.mjs`
first), `contract prune`, `targetedFix`, `usagePolicy`, `budgetProfile`,
`progressPolicy`, `runtimeRules` (replaced by `runtimes[].fallback` per
runtime plus a validation that every worker/fallback pair keeps a judge from
another vendor), the line-ceiling ratchet in `test/ci-policy.test.mjs`, and
their tests. Kept: `.runs/` artifacts, deterministic verification, worker
result file, tool-policy hook (foreground-only, bounded output), replay driver
and its cases, campaign journal and HANDOFF, AGENTS.md signal block,
capability preflight, failover on provider exhaustion for workers and judges,
`doctor`/`preflight`.

## 4. Dashboard brief (phase 3)

One column, max width 1100 px, light and dark, SSE as today. Order:

1. **Now strip.** `active run · state · running node (elapsed) · USD so far ·
   updated N s ago`; when idle: `Idle · last run <id> finished <ago>`.
2. **Needs you** banner, only when attention exists: one line per item with
   the copyable command that resolves it (`resume`, `resume --reconcile`,
   `cancel`, an answer).
3. **Runs table** for the selected campaign, newest first: status pill, run
   id, goal (one line), nodes done/total, attempts, elapsed, USD, updated.
   Campaign chosen from a dropdown in the header, no left column.
4. **Run drawer** on click: node rows (state, attempt, model, elapsed, USD,
   verdict pill, one-line note); per node tabs: worker log tail (200 lines,
   streaming), verification (per command pass/fail, output tail), diff
   (`--stat` and file list), findings (severity, text), prompt.
5. **Handoff** tab renders the campaign `HANDOFF.md`.

Removed: live feed, ledger epochs, weighted tokens anywhere, decisions,
questions, constraints, intents, outcomes, sessions, notifications list,
heartbeat-derived state. `status <run-dir>` prints the same order as the page:
needs-you, now, nodes, cost. Snapshot payload ≤ 200 KB.

## 5. Campaign plan

Five phases, one contract each except phase 2 (two), run by the runner
committed at the previous phase from an immutable snapshot (`git archive HEAD
skills/mine/intent-factory` into
`.runs/control/intent-factory-lean-20260905/controller-p<N>/`). Phase 0 runs
on 0.2.0 and therefore uses `mode: "autonomous"` packets with `writeRoots`
(whole-repo read, directory-scoped write), the only closed-scope shape 0.2.0
offers that cannot suffer the enumeration defects.

A phase always runs on the runner shipped by the previous phase, so a
feature becomes available to the campaign one phase after it is implemented.
Phase 0 and phase 1 therefore share one mutable tree and their nodes are
chained with `dependsOn`: a failed node stops the phase instead of letting
its partial edits leak into the next node, and `resume` re-dispatches the
failed node and unblocks the rest after the orchestrator has quarantined or
fixed the tree. Attempt worktrees, implemented in phase 1, isolate nodes from
phase 2a onward, where edges are needed only for real data dependencies.

**Bootstrap commit (orchestrator, before phase 0).** Delete the per-file line
ceilings from `test/ci-policy.test.mjs` (keep the empty-catch ceiling, the
symlink check and commitlint). Every phase-0 node adds behaviour to
`runner.mjs`, which sits one line under its ceiling, and the ratchet boxed
two nodes into defeat last campaign.

The contract-level `finalVerification` is not used in any phase: it is capped
at 600 s and the full suite takes 9 min 32 s on an idle machine (the last
campaign's `release-1-docs` blocked on exactly that). The orchestrator runs
`npm test` at every phase close instead.

Worker assignment: `sonnet` (`claude-sonnet-5`, `bypassPermissions`) by
default for runner code; `luna` (`gpt-5.6-luna`, xhigh, codex
`workspace-write`) for the nodes with the most concurrency reasoning (retry
in place, worktree integration, controller lock); `glm` (`glm-5.3[1m]`) for
the dashboard page, status line and documentation. Judge `sol` (medium, codex
`read-only`) for Claude and GLM workers, `opus` (`claude-opus-5`) for Luna
workers. Worker fallback on exhaustion is a single hop that keeps the vendor
split: sonnet → glm (judge sol) and luna → glm (judge opus); a GLM worker
that also exhausts is `attention`, never a second hop to an Anthropic worker
under an Anthropic judge. 0.2.0 synthesizes no judge failover, so a judge
exhaustion in phase 0 is `attention`, resolved by `resume` after the
provider window resets. From phase 1, `runtimes[].fallback` covers judges
too, and a judge fallback is taken only when its vendor differs from the
vendor of the worker runtime actually used for that attempt (`opus` may
replace `sol` for a Luna or GLM worker, never for a Sonnet worker; `sol` may
replace `opus` for a GLM worker, never for a Luna worker); validation rejects
any statically reachable worker/judge pair from one vendor, and an
unavailable judge with no admissible fallback is `attention`. Phase 0 gates
are blocking at
`failOn: ["major", "critical"]`, `maxRevisions: 1`; from phase 1 the default
is `advisory` and only nodes that change the gate, the lock or the
integration transaction are `blocking`.

| Phase | Node | Worker | Outcome | Proof |
|---|---|---|---|---|
| 0 unblock | `scope-advisory` | sonnet | On a completed implementation attempt whose controller verification passed, `unexpected_write` becomes a recorded finding (paths listed, event appended, shown to the judge and in status) and the node proceeds to the gate; when verification failed, the existing failure path applies unchanged with the unexpected paths appended to the message. `writeRoots` accepts file paths. `declared_paths_changed`, unknown-effect/materialization guards and ignore-source integrity are untouched. | targeted tests via `verification`, `check` and `typecheck` proofs |
| 0 | `review-modes` | sonnet | `gate.review: none\|advisory\|blocking` (default advisory; `gate: false` is none); verdict candidates are counted at the provider boundary (codex driver: separate agent messages; empty output; missing terminal envelope; timeout) and zero-or-many candidates trigger one bounded re-ask, after which advisory records `invalid_judge_output` and completes while blocking enters `attention` (`blocked`, `judge_unavailable`) with the worker result and verification preserved; validation requires `critical` whenever `major` is in `failOn` and `major` for blocking; `proof: {kind: "verification", ref: <index>}` reuses a recorded verification result by reference. Node snapshot validation admits the new fields. | targeted tests, `check`, `typecheck` |
| 0 | `retry-in-place` | luna | `resume <run-dir> [--node <id>] [--reconcile <id>] [--max-input-tokens <n>]`: adopt and re-judge first, including `judge_unavailable` nodes, which are re-judged and never re-dispatched; then re-dispatch ordinary failures and `dependency_failed` nodes as attempt+1 with a bounded 'Previous attempt' section; `unknown_effect_reconciled` needs `--reconcile`; exhausted run budget is attention unless extended explicitly; a `gitHead` descendant is accepted and recorded, a non-descendant refused, a dirty-tree mismatch warns. `contract prune`/`targetedFix` removed. | targeted tests, `check`, `typecheck` |
| 1 isolation | `attempt-worktrees` | luna | attempt branches and worktrees per rule 1; integration transaction per section 3 (single state write carrying `integratedHead`, derived integration head, recovery of merged-but-unwritten attempts), conflicts as attention. Chained after nothing; `parallel-and-fallback` depends on it. | two-node tests with disjoint and overlapping writes; crash-after-merge-before-write and repeated-integration tests on the replay driver |
| 1 | `parallel-and-fallback` | sonnet | `maxParallel` > 1 accepted; ready nodes without edges run concurrently in their worktrees; `runtimes[].fallback` replaces `runtimeRules` for workers and judges with the vendor-split validation of section 5; capability preflight kept. | three independent replay nodes; fallback tests for worker and judge including a rejected same-vendor pair |
| 2a budget | `budget-usd-schema3` | sonnet | schema 3: `maxCostUsd` per node and run, `pricing` per runtime, `usage.jsonl` per attempt with `unknown` usage counted; `usagePolicy`, `budgetProfile`, `progressPolicy`, ledger epochs, segments, continuations and `capsule.mjs` removed together with their tests; `metrics.mjs`, `dashboard.mjs`, `render.mjs` and `status` read the new records so the suite is green at phase end. | tests; full suite by the orchestrator |
| 2b process | `controller-lock` | luna | `lock.mjs` per rule 5: atomic acquisition, stale detection by pid and start time, takeover that terminates every recorded invocation process group before dispatching; `supervisor.mjs`, `lease-liveness.mjs`, supervisor lease and generations removed; stale controller visible in status; tests for two contenders, pid reuse (start-time mismatch) and an orphaned detached invocation reaped on takeover. | tests |
| 2b | `status-and-notify` | sonnet | `status.json` per run and `.runs/status.json` written each tick; notify with receipts and bounded retry per rule 6 (`notify.jsonl`); heartbeat, liveness journal, outbox, cursors and projector removed after `metrics.mjs`, `dashboard.mjs` and the status line are switched to `status.json`, `usage.jsonl` and `notify.jsonl`; `campaign sync`/`ack` keyed by journal event ids; `campaign-autonomy.mjs` and `campaign start/supervise/configure/drain/watch` removed. | tests; full suite by the orchestrator |
| 3 visibility | `dashboard-v2` | glm | page and server per section 4 over `status.json`, node JSON, `events.jsonl`, `usage.jsonl`, `notify.jsonl`. | server API tests and a DOM test on the rendered snapshot |
| 3 | `status-surfaces` | glm | `status` CLI order, status line ≤ 40 lines reading `.runs/status.json`, notify one-line templates. | tests |
| 4 release | `runner-split` | luna | `runner.mjs` split per the section 3 table; no behaviour change. | full suite, unchanged pass count |
| 4 | `docs-v03` | glm | SKILL.md ≤ 6 KB, contract.md ≤ 20 KB, operations.md ≤ 10 KB describing only what exists; other references deleted or merged; history moved to `docs/intent-factory/`. | byte-ceiling test; link check |
| 4 | `metrics-v03` | sonnet | indicators of section 6 over `usage.jsonl`, node attempts, `notify.jsonl` receipts and active intervals, including the reporting-only `tokensByKind` sums (uncached input, cache read, output) per campaign and per runtime; `ambientCoverage`, `silentStallRate` and every weighted-token indicator deleted; baseline fixture from this campaign's own records. | tests |
| close | orchestrator | — | version 0.3.0, retrospective note, `campaign close`, push. | full suite |

Every node's Definition of Done: mechanical items are `npm run check` and
`npm run typecheck` as command proofs (each well under the 120 s gate cap) and
the node's targeted tests as `verification` entries run by the controller
(600 s), never as proofs; at most three judgment items, each naming an
observable (a file, a command output, a test name). Every packet carries the
same fixed footer (worker result shape, foreground-only, bounded output)
rendered by the runner, never repeated in `instructions`. Packets never
forbid the canonical result file the controller designates under
`.runs/<run>/results/`; they forbid touching campaign control artifacts.

### Operating rules for this campaign

- One contract per phase, authored in one turn, validated and preflighted
  before launch.
- On the 0.2.0 runner (phases 0 to 2a) the contract `maxInputTokens` is
  6 M weighted as a safety net only; from 2b the safety net is `maxCostUsd`.
  `stallTimeoutSec` 900, `timeoutSec` 3600.
- After each phase: orchestrator runs `npm test`, reviews the diff, commits
  with Conventional Commits, records an outcome note (attempts, USD, wall
  clock, first-attempt rate), refreshes the controller snapshot.
- The control session checks status at most once per wake and acts only on
  terminal states or attention. Progress reaches the human through the notify
  bin and the dashboard.
- A retry is `resume`, never a new contract, from phase 0 onwards (phase 0
  itself may need one legacy take if `retry-in-place` is the node that
  fails).
- Records needed by section 6 are captured from phase 0: per-attempt usage
  and cost with provenance (provider-reported or priced, `unknown` otherwise),
  attempt and revision counters per logical node, notify receipts from phase
  2b, active intervals from `events.jsonl`.

## 6. Targets, measured at close by `metrics`

Denominators: a *logical node* is a contract node id within one run;
*attempts* are worker starts; *first-attempt success* is logical nodes `done`
at attempt 1 over all logical nodes that reached a terminal state (nodes still
pending at close are reported as censored, not as failures); *runs* are run
directories linked to the campaign; *cost* is USD summed over provider-reported
cost plus priced usage, with `unknown` invocations counted separately.

| Indicator | 0.2.0 campaign | v0.3 |
|---|---|---|
| Logical nodes done at any attempt | 22 % (29 of 129) | ≥ 70 % (hypothesis) |
| Linked runs per closed checkpoint | 2.04 | ≤ 1.3 |
| Runs per campaign | 49 | ≤ 8 (6 contracts + retries by resume) |
| Wall clock | 4 days | ≤ 2 days (hypothesis) |
| Tokens by kind, all vendors (reporting only, no weighting) | uncached input 8.6 M · cache read 321 M · output 3.0 M | uncached input ≤ 4 M · cache read ≤ 150 M (hypotheses); ledger records cover phases 0-2a, `usage.jsonl` covers the rest, `tokensByKind` sums both |
| Cost, all vendors | USD 69.68 Claude only, others unrecorded | reported in full with provenance; Claude ≤ USD 150 |
| Blocking judge first-pass rate | 0.5 (`sol-medium`) | ≥ 0.7 |
| Notifications | 0 of 99 delivered | 100 % of terminal/attention events carry a receipt (`delivered` or `failed` after 3 tries) within 60 s |
| Silent stalls over active run time | mis-measured | 0 |
| Production `.mjs` lines in the skill | 24,859 | ≤ 10,000 (estimate, re-baselined after phase 2) |
| Skill docs | ≈ 200 KB | ≤ 40 KB |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Phase 0 runs on the brittle 0.2.0 runner | three chained nodes, autonomous packets, blocking Sol/Opus gates at major+critical, orchestrator full suite before commit, `resume` for retries |
| Deleting features breaks readers and tests that encode them | every deletion node adapts the readers first and deletes the feature with its tests in the same node; the DoD is the full suite green with the lower test count recorded |
| Worktree integration conflicts or semantic breakage | verification of the integrated candidate; conflicts are attention; idempotent re-integration test |
| Two controllers | atomic lock with pid and start time, takeover kills the process group, tests for contenders and pid reuse |
| Luna xhigh is slow | four nodes only; `timeoutSec` 3600; Opus judge |
| GLM quota (429 code 1310) | fallback glm → sonnet; GLM carries only leaf nodes |
| Judge vendor availability (Codex 5-hour window) | preflight before launch; judge exhaustion is attention in phase 0, role-aware fallback from phase 1 |
| The orchestrator re-authors instead of resuming | rule in section 5; runs-per-checkpoint reported at close |

## 8. Non-goals

Planner agent, golden eval set, containers, multi-tenant, remote deployment,
new drivers, changing the worker result protocol, replacing Conventional
Commits or the pre-commit hooks.

## 9. Decisions taken on the reviewer's open questions

1. Unavailable blocking review: the node enters `attention`; `resume`
   re-judges the preserved work, using the declared fallback judge when the
   primary is exhausted (phase 1 onwards); the operator may reconcile
   explicitly instead. Never a silent pass.
2. Notification delivery: durable receipts with three bounded retries; the
   target is a receipt for every terminal/attention event, not guaranteed
   delivery.
3. Retry in place means another attempt with the unchanged packet plus, at
   most, an explicit budget extension recorded in the run. Packet or
   instruction corrections are a new run.

## 10. Review record

### Round 1 (2026-09-05, gpt-6-astra xhigh, read-only, about 12 minutes)

Verdict `contested`: 16 findings, 8 blocking. All accepted; responses:

| Finding | Response |
|---|---|
| F01 diagnosis overstated | unique incidents counted, shipped fixes distinguished, comparisons labelled hypotheses (0, 1) |
| F02 repeated context and verification missed | error 11 added; verification once per attempt with proof reuse (3) |
| F03 `exec-jsonl.mjs` is a shared dependency | shared utilities extracted to `drivers/protocol.mjs` before deleting the adapter (3) |
| F04 blocking review degraded silently | blocking enters attention with work preserved; advisory completes (rule 2, 9.1) |
| F05 pid check is not a lock | atomic lock with pid and start time, takeover kills the group, stale visible (rule 5, 2b) |
| F06 worktree integration undefined | attempt branches, serialized integration, candidate verified, idempotent repair (3, phase 1) |
| F07 cursors and delivery retry lost | sync/ack on journal ids; receipts with bounded retry; target restated (rule 6, 6, 9.2) |
| F08 unquoted proofs, 120 s cap | tests moved to `verification`; proofs are `check` and `typecheck` only (5, contract) |
| F09 `failOn` exact membership | `["major", "critical"]` in phase 0; validation rule in `review-modes` (rule 2, contract) |
| F10 packets forbade the result file | packets forbid control artifacts only (5, contract) |
| F11 wrong scope semantics, weakened snapshot | advisory only for `unexpected_write` on completed attempts; guards untouched; red path unchanged (phase 0, contract) |
| F12 `parseJudge` alone cannot see multiplicity | candidates counted at the provider boundary; four failure shapes tested; snapshot schema updates authorized (phase 0, contract) |
| F13 retry over-promised | adopt first, ordinary retry, `--reconcile`, budget attention with explicit extension (rule 4, contract) |
| F14 judge fallback absent, vendor split broken | fallback routes re-drawn; judge exhaustion is attention in phase 0; `runtimes[].fallback` with vendor validation in phase 1 (5) |
| F15 phases not working checkpoints | phase 0 chained; readers adapted in the deleting node; phase 2 split into 2a and 2b; records captured early; `finalVerification` row corrected (5, 7) |
| F16 target denominators mixed | denominators defined, hypotheses labelled, code-size estimate re-baselined (6) |

### Round 2 (2026-09-06, gpt-6-astra xhigh, read-only, at `cbf3dfe`)

Verdict `contested`: F01-F04, F07-F12 resolved; F05, F06, F13-F16 open; one
new blocking finding. Responses, all accepted:

| Finding | Response |
|---|---|
| F05 takeover missed detached invocation groups | takeover terminates every recorded invocation process group before dispatching; reaping test (rule 5, 2b) |
| F06 `done` written before the integration head | one state write carrying `integratedHead`; head derived from the run branch; merged-but-unwritten recovery (3, phase 1) |
| F13 `judge_unavailable` would be re-dispatched, and the packets forbade the fix | resume re-judges unresolved-review nodes; `retry-in-place` is authorized and tests it (rule 4, contract) |
| F14 second hop reached an Anthropic worker under Opus; judge fallback broke the split | single-hop worker fallback to GLM only; judge fallback admissible only across vendors, validated statically (5, contract) |
| F15 phase 1 shares the tree too | phases 0 and 1 chained; isolation from 2a (5) |
| F16 weighted target with the indicator deleted | reporting-only `tokensByKind`; targets restated in raw token kinds (4, 6) |
| F17 proof reuse by joined argv is unsound | `proof: {kind: "verification", ref: <index>}` by reference; command proofs always execute (3, contract) |

Round 3: pending, targeted at F05, F06, F13-F17.
