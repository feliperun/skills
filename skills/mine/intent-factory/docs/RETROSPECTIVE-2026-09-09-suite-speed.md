# Retrospective — intent-factory-suite-speed-20260909

Closed 2026-09-09 on branch `campaign/suite-speed-20260909`, cut from `main`
after `work/fixes` merged. Two runs, three nodes, USD 9.47. Worker
`deepseek-v4-flash`, judge and reviewer `claude-opus-5` — owner-chosen
routing. This campaign attacked the three problems left open by
[RETROSPECTIVE-2026-09-09.md](RETROSPECTIVE-2026-09-09.md).

## What shipped

1. **The suite gates itself now.** `scripts/runner.test.mjs` — 165 sequential
   tests in one 5,039-line file — was 97 % of the suite's wall clock, because
   node's runner parallelizes *files*, not tests within a file. It is now 8
   themed files (282–873 lines each) under `test/`, with the ~15 local
   fixture helpers extracted into `test/runner-helpers.mjs`. Measured full
   suite: **661 s → 198 s**, 500 tests, 498 pass, 0 fail, 2 skipped. A packet
   can finally declare `npm test` as a `verification` entry and stay inside
   the 600 s per-entry cap with 3× headroom — the campaign's own later nodes
   did exactly that.
2. **The first safe diet layer.** The eight exported symbols with no
   reference anywhere (`isRuntimeAvailability`, `boundedChars`,
   `captureWorktreeIdentity`, `synchronizeRunUsage`, `addCost`,
   `accumulateSessionMetrics`, `isUnknownEffectTerminal`,
   `uncitedReaskSuffix`) are deleted, and every export used only inside its
   own module lost the `export` keyword.
3. **The CLI describes itself honestly.** The usage line advertised
   `contract <prune|validate>` for a subcommand deleted a campaign ago; it
   now reads `contract validate <contract.json>`, and the worker also
   repaired the `campaign` subcommand list, which had omitted
   `watch`/`sync`/`ack`.

## Two runner defects the campaign exposed, both fixed

Neither was the worker's doing; both were found by the orchestrator reading
the failure evidence, and both are now covered.

1. **The integration candidate had no `node_modules`** (`ce675f9`). Attempt
   worktrees get the repository's `node_modules` linked in;
   `createCandidateWorktree` did not. So `split-runner-test` passed its own
   verification in the attempt worktree — 206 s, 499 tests, 0 fail, the
   deliverable proven — and then failed the identical suite in `.candidate`,
   where `test/ci-policy.test.mjs` could not execute the `commitlint` binary
   and threw a bare `TypeError: The "message" argument must be one of type
   string or function. Received undefined`. The gate reported "the sealed
   candidate did not pass the node verification in its integration
   worktree", which reads as a defect in the node's own work. **A node can
   pass its own gate and fail integration for an environment reason, with
   nothing in the error surface saying the two worktrees differ.**
2. **Re-sealing a clean attempt killed every retry** (`6e1afef`). This is the
   more serious one, and it had been misdiagnosed as a cascade twice.
   `sealAttempt` probed for dirtiness excluding only `.runs`, while the
   staging step also unstages `node_modules` — a symlink that `node_modules/`
   in `.gitignore` never matches. An already-sealed attempt whose sole entry
   was that link therefore read as dirty, staged it, unstaged it, and
   committed an empty change set: `git commit` exits 1, surfacing as
   `worktree_create_failed`. Every retry and every `resume` of a sealed node
   died there. It killed both nodes of `intent-factory-gaps-20260909-run1`
   and blocked this campaign's first resume. A red→green regression test
   pins it (`test/integration.test.mjs`).

The rule from the previous retrospective held: no packet asked a worker to
run the full suite, and no worker backgrounded a long command this time.

## A measurement that was wrong

`RETROSPECTIVE-2026-09-09.md` reported **25,257 production `.mjs` lines**
against a ≤10,000 target. That number counted `scripts/runner.test.mjs` — a
5,039-line **test** file that happened to live in the scripts directory.
Real production lines were ~20,218 before this campaign and are **20,130**
after; the dead-export sweep removed ~88 lines, and the gap to the target was
overstated by 5,039. The split fixed the mismeasurement as a side effect by
moving the test out of `scripts/`.

The honest reading: this campaign did not meaningfully move the line count,
and never intended to — the constraint recorded before authoring says so
outright. Of 179 exports with no external reference, only 8 were dead; the
other 171 are live code used inside their own modules. **The remaining
~10,000 lines above target are working implementation, not dead weight**, and
closing that gap needs a deliberate architectural campaign that decides what
capability to remove — not another sweep.

## Cost and shape

Three nodes, USD 9.47. `split-runner-test` cost USD 3.72 across five attempts
— attempts 1–4 were consumed entirely by the two runner defects above, not by
bad work: attempt 1's diff was already correct and every later attempt
correctly continued from its sealed sha rather than redoing it. The other two
nodes landed on attempts 1 and 2. DeepSeek Flash handled a 5,039-line
mechanical split competently under a blocking Opus gate; Opus rejected one
`cli-usage-string` attempt before passing the second.

## Problems left open

1. **The production line count still sits at 20,130 against ≤10,000**, and
   the path there is removing capability, not sweeping. Any future campaign
   should first decide whether ≤10,000 is still the right target for what
   the runner now does, rather than treating it as an unquestioned number
   inherited from the lean tech spec.
2. **Integration-environment parity is unproven in general.** The candidate
   worktree now links `node_modules`, but nothing tests that the attempt and
   candidate environments agree; the next divergence will surface the same
   way — as a node blamed for its own correct work.
