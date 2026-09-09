# Retrospective — intent-factory-lean-20260905 (v0.3 "lean")

Closed 2026-09-08. Campaign branch `campaign/lean-v03`, five phase contracts
(`docs/intent-factory/campaigns/intent-factory-lean-20260905/control/phase-*.contract.json`),
29 linked runs, 26 recorded decisions, 31 outcome notes. Plan:
[TECH-SPEC-2026-09-05-lean.md](TECH-SPEC-2026-09-05-lean.md).

## What shipped

Eight target rules from the plan, all landed:

1. **Whole repo, own branch and worktree per attempt** — `scripts/worktree.mjs`,
   `refs/intent-factory/<run>/run`, attempt branches `if/<run>/<node>/<attempt>`.
2. **Verification is the gate** — command and workspace proofs before any judge;
   `review: none|advisory|blocking`; a bounded judge re-ask.
3. **No spend ceiling** — `maxInputTokens`, `maxCostUsd`, `usagePolicy`,
   `budgetProfile`, `progressPolicy` and the file-change watchdog are deleted
   (schema 3). `timeoutSec`/`stallTimeoutSec` and the provider's own allowance
   are the only limits; usage is recorded in `<run-dir>/usage.jsonl` for
   reporting only.
4. **Retry in place, and continuation from the sealed attempt** — `resume`
   adopts and re-judges before re-dispatching; a re-dispatched attempt N+1
   continues from attempt N's sealed sha instead of discarding it (this
   campaign's own field evidence — see below — made the second half mandatory,
   not optional).
5. **One controller, an atomic lock, files as state** — `scripts/lock.mjs`
   replaces the supervisor lease and generation fencing; `supervisor.mjs` and
   `lease-liveness.mjs`'s callers are gone. *(`lease-liveness.mjs` itself
   survives — see Known gaps.)*
6. **Notify with receipts** — `scripts/notify/index.mjs` calls
   `INTENT_FACTORY_NOTIFY_BIN` directly with three bounded retries and a
   `notify.jsonl` receipt; `heartbeat.mjs`, `outbox.mjs`, `events.mjs`
   (the projector) and `campaign-autonomy.mjs` are deleted.
7. **Docs fit in one sitting** — `SKILL.md` 5271 B, `references/contract.md`
   16054 B (was 48231), `references/operations.md` 9079 B, each under its
   ceiling and enforced by `test/docs-diet.test.mjs`; `references/routing.md`
   and `session-memory.md` deleted; history moved to `docs/intent-factory/`.
8. **Discover the models, assign them by role** — `doctor --discover`,
   `runtimes[].fallback` with resolved vendor identity, tier-based composed
   assignment, same-tier re-tiering on exhaustion (`scripts/runtime-discovery.mjs`,
   `scripts/failover.mjs`).

`runner.mjs` (7738 lines at phase-0 close) is now CLI-only (824 lines), split
into `scheduler.mjs` (1341), `node.mjs` (3923 — see below), `review.mjs` (222)
and `drivers/protocol.mjs` (422), with no behaviour change (full suite:
identical 492/490/0/2 before and after). The dashboard and status surfaces
(`dashboard/dashboard.mjs`, `dashboard/index.html`, `statusline/claude-code.sh`,
`scripts/render.mjs`) were rebuilt over `status.json`, `usage.jsonl` and
`notify.jsonl` in the section-4 order (now strip, needs-you, runs table, run
drawer, handoff tab); `scripts/metrics.mjs` computes the ten section-6
indicators over the same records, with a baseline pinned from this campaign's
own runs (`test/fixtures/lean-campaign-baseline/`).

## Section 6 indicators, this campaign as its own baseline

Measured 2026-09-08 with the shipped `metrics` command
(`node skills/mine/intent-factory/scripts/runner.mjs metrics intent-factory-lean-20260905 --json`).
The 0.2.0-campaign column is the number recorded in the tech spec (section 0);
several v0.3 indicators have no 0.2.0 equivalent because the metric itself
changed shape (weighted tokens deleted, `silentStallRate` redefined from
`events.jsonl` intervals instead of the heartbeat).

| Indicator | 0.2.0 campaign | v0.3 target | v0.3 measured |
|---|---|---|---|
| Logical nodes done at any attempt (`nodesDoneRate`) | 22 % (29/129) | ≥ 70 % | 19.6 % (56 terminal nodes; hypothesis not met — see below) |
| Linked runs per closed checkpoint | 2.04 | ≤ 1.3 | 2.64 |
| Runs per campaign | 49 | ≤ 8 | 29 |
| Wall clock | 4 days | ≤ 2 days | ~2.7 days (2026-09-05 21:06 → 2026-09-08 23:5x) |
| Tokens by kind (all vendors, reporting only) | uncached 8.6 M · cache read 321 M | uncached ≤ 4 M · cache read ≤ 150 M | uncached 2.63 M · cache read 390.6 M (cache read over target; see below) |
| Cost, all vendors | USD 69.68, Claude only | ≤ USD 150 | USD 97.18 recorded with provenance; `unknownCount` 5 of 13 (DeepSeek codex-driver invocations report no cost) |
| Blocking judge first-pass rate | 0.5 (`sol-medium`) | ≥ 0.7 | 1.0 (sol, n = 2 blocking-gate attempts; too small a sample to trust) |
| Notifications delivered within 60 s | 0 of 99 | 100 % | 1.0 (14 receipts, all delivered, after the eventId fix in phase 3) |
| Silent stalls over active run time | mis-measured | 0 | 0.0883 (104 intervals; not zero — see below) |
| Production `.mjs` lines in the skill | 24,859 | ≤ 10,000 | not remeasured at close; `runner.mjs` alone dropped 7738→824, `node.mjs` is 3923 |
| Skill docs | ≈ 200 KB | ≤ 40 KB | ~30 KB (`SKILL.md` + `contract.md` + `operations.md`) |

**Reading the misses honestly**: `nodesDoneRate` missed its hypothesis because
most of this campaign's 56 terminal nodes were takes that died to *operating*
defects (rotation, the seal bug, commitlint drift), not to bad code — the
first-attempt success rate across every suite-fix and diet take was 0. Runs
per checkpoint (2.64) and cache-read tokens (390.6 M) are both driven by the
same cause: repeated takes on long, context-heavy Sonnet sessions. The lean
redesign fixed the *mechanism* class of waste (dependency-chain collateral
damage, budget-ceiling kills, supervisor lease races) but a new class —
integration-layer defects that only a real non-empty attempt could expose —
took its place, and every one of them cost a full take. `silentStallRate`
above zero and the small first-pass sample both need a longer-running
campaign to read with any confidence; report them as unconfirmed instead of
claiming compliance.

## Field defects this campaign exposed (all root-caused and fixed)

Ordered by when they were found:

1. **Progress watchdog killed a healthy worker reading code** (phase 0, 0.2.0
   runner) — the default `progressPolicy` counted only file changes.
2. **Budget ceiling on a unit nobody is billed in** — a synthetic
   `cacheReadWeight` crossed a 5 M ceiling from legitimate cache reads; the
   owner's decision to delete every ceiling (rule 3) traces directly to this.
3. **`cacheReadWeight` doubled as the session-rotation trigger** — setting it
   toward zero for the no-ceiling decision silently disabled rotation-based
   session handoff, rotating a healthy worker every ~12 minutes instead.
4. **Automatic Claude session rotation discarded worktree edits.** The
   600-turn rotation re-dispatched a node into a *fresh* worktree cut from the
   run ref, abandoning the previous attempt's uncommitted work — hit twice
   (phase 1e, phase 1f) before phase 2a deleted rotation outright. This is the
   direct cause of rule 4's "continue from the sealed attempt," folded in
   after the fact.
5. **`sealAttempt` could never seal a real, non-empty attempt.** It named the
   ignored `.runs` result sidecar through a git exclude pathspec; `git add`
   exits 1 with `advice.addIgnoredFile` the instant that ignored directory
   exists, which is exactly when a worker has finished. No node integrated
   through the runner's own transaction before 2026-09-08 17:45Z — every
   earlier "done" node in this campaign was landed by the orchestrator
   cherry-picking a worktree diff by hand, not by the runner's integration
   transaction working as designed. Fixed as: stage everything, then unstage
   `.runs` (and, once discovered, `node_modules`).
6. **The seal committed a `node_modules` symlink.** `createAttemptWorktree`
   links the repository's `node_modules` into every attempt worktree so
   `tsc`/tests can run without a copy; `node_modules/` in `.gitignore` matches
   a real directory but not a symlink of the same name, so the first
   integrated attempt committed the link. Cherry-picking that commit replaced
   the checkout's real `node_modules` with a self-referencing symlink,
   silently breaking the pre-commit and commit-msg hooks (`npm run check`
   exited 194 with no visible file-level error) until `npm ci` restored it.
7. **Notify receipts were silently wrong twice in a row.** First
   `no_transport` because the Ford env file assigns without `export` and `sh`
   does not export sourced assignments (`launch-phase.sh` now sources it
   under `set -a`); then `failed: eventId is invalid` because the human
   channel adapter rejects an event with no id (notify events now carry a
   stable `eventId` derived from the dedupe key).
8. **A headless worker that "pauses to wait" ends its session with no
   result file**, which the controller reads as `protocol_failure` and
   discards the attempt — not a timeout, not a stall, just a silently empty
   turn. Every packet from phase 1f onward states this explicitly and
   requires foreground commands with an explicit tool timeout.
9. **`npm install` inside an attempt worktree fails the snapshot-integrity
   check** (`snapshot_ignore_changed`) because the husky `prepare` hook writes
   `.husky/_/.gitignore` mid-node. Packets forbid it; `node_modules` is
   linked in instead (see #6).
10. **The 600 s per-verification-entry ceiling stopped fitting
    `runner.test.mjs` as it grew** — split from one entry, to three
    (`^r`/`^a`/`^[^ar]`), to four (`^r`/`^a`/`^[b-oB-O]`/`^[p-zP-Z]`) over the
    course of phases 1f–3.
11. **`changedFiles` over the worker-result protocol's 32-entry cap** is a
    silent `protocol_failure` on an otherwise-complete, judge-approved node
    (hit once in phase 3); packets now state the cap explicitly.
12. **Chaining past a failed `commit` silently launches the next take from
    the wrong base.** `commitlint`'s body-line-length rule rejected a commit
    message twice (phase 2b, twice) inside a compound shell command whose
    later steps still ran; both times a take was launched believing work was
    landed that wasn't. The routine is now: assert `git status --short` is
    empty *after every commit*, not just before the next command.
13. **Anthropic's soft session limit reads exactly like the hard one** in the
    error string (a phase-4 take hit `"session limit resets 8:30pm"` and both
    nodes failed instantly); confirmed reset before resuming rather than
    treating it as terminal — this is the exact behaviour rule 8 was written
    to generalize, still only handled ad hoc for Anthropic, not normalized by
    a driver (see Known gaps).
14. **DeepSeek is a real prepaid balance, not a rate limit** — a 402
    Insufficient Balance mid-phase-2a is a different exhaustion class again
    from the Z.ai weekly quota and the Anthropic session limit; this campaign
    now has field evidence for three distinct provider-exhaustion shapes, and
    rule 8's `{available, exhaustedUntil, reason}` normalization only
    generalizes two of them (quota-with-reset). A hard balance stop has no
    `exhaustedUntil` to report.

## Known gaps (not blocking, recorded for the next campaign)

- `lease-liveness.mjs` survives phase 2b's supervisor deletion:
  `runner.mjs`'s detached-bootstrap handshake and `store.mjs`'s generation
  fence still import `processStartTokenOf`/`leaseAdoption`/`holderLiveness`
  from it. Not dead code, but not renamed or folded into `lock.mjs` either —
  a real module boundary the split didn't resolve.
- `controller.lock`'s `processStartToken` records `null` on this machine (a
  macOS quirk in how the token is derived), so the pid-reuse detection half
  of takeover has never been exercised for real; only the "pid is dead" half
  has field evidence.
- Provider-exhaustion normalization (rule 8) has direct evidence for Z.ai
  code 1310 and the Anthropic session-vs-spend-limit distinction, but no
  driver-level test proves the Anthropic case end-to-end (a fake-provider
  fixture would need to fabricate the exact error string); DeepSeek's 402 is
  not modeled by `{available, exhaustedUntil, reason}` at all since a
  depleted balance has no reset instant.
- `docs/intent-factory/campaigns/intent-factory-lean-20260905/` (this
  campaign's copied control artifacts, contracts, launch scripts and journal,
  committed so the campaign could continue from a second machine) is
  reference material, not something later campaigns should treat as a
  template — the absolute paths inside are specific to the machine that
  wrote them.

## Cost and process, this campaign

29 linked runs across 5 phase contracts (plus repairs and takes), 26 recorded
decisions, 4 attached sessions (3 Claude Code, 1 Codex), one session handoff
across machines. First-attempt success on every diet/split/suite-fix take was
0 — every failure listed above was an operating defect of the runner or the
orchestration around it, never a defect in the requested behaviour itself.
The campaign closes with the lean architecture proven end-to-end at least
once for every rule, including integration (#5 above was the last rule to get
real field evidence, on 2026-09-08 at 23:43Z with `runner-split`).
