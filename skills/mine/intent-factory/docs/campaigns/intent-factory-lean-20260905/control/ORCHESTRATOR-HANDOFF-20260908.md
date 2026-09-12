# Orchestrator handoff — campaign intent-factory-lean-20260905

Written 2026-09-08 ~19:30Z by the Claude Code session fcc2f493-0e59-43d7-a4e6-9a7b8958080a
for the next control harness. Everything here is also in the campaign journal
(`.runs/campaigns/intent-factory-lean-20260905/journal.jsonl`, rendered as `HANDOFF.md`
by `campaign show`), but this file is the runbook.

## Where the campaign stands

| Phase | State | Commit on `campaign/lean-v03` |
|---|---|---|
| 0 unblock, 1 isolation | closed | `85d53c9` |
| 1 close (suite 60 failures → green) | closed | `0657afa` |
| 2a diet (schema 3, no ceilings, `usage.jsonl`) | closed | `ad0a8a0` |
| 2b process | closed | lock `0f7c9cd` · status/notify `e6933c3` · continue-from-sealed `f39fcca` |
| 3 visibility | closed (landed by the orchestrator, see below) | `6c1d240` status surfaces · `2a60917` dashboard v2 · `88064c4` fixes |
| 4 release | **not started** — contract ready | `phase-4.contract.json` |
| close | not started | — |

Branch `campaign/lean-v03` is pushed through `88064c4` if the last full suite was green (the
phase-3 close note in the journal records the counts). Last measured suite before the fixes:
481 tests, 479 pass, 0 fail, 2 skipped.

Owner directives in force: Anthropic and DeepSeek runtimes only (Codex stays out even though
its allowance reset); every successful phase committed and pushed; never sit idle after a
terminal state; the system notifications from the test suite must stay silent (the helpers
default `INTENT_FACTORY_NOTIFY_BIN` to a no-op).

## Next step: phase 4

1. `cd /Users/frb/dev/frb/skills && git status --short` must be empty and `git log -1` must be
   the phase-3 close. If a fix commit landed after `88064c4`, edit the `Phase 3 closed at`
   sentence in `phase-4.contract.json` (three nodes) to the real sha.
2. Snapshot the controller from HEAD:
   `CTRL=.runs/control/intent-factory-lean-20260905; rm -rf $CTRL/controller-p4; mkdir -p $CTRL/controller-p4; git archive HEAD skills/mine/intent-factory | tar -x -C $CTRL/controller-p4; git rev-parse HEAD > $CTRL/controller-p4/HEAD`
3. `node $CTRL/controller-p4/skills/mine/intent-factory/scripts/runner.mjs validate $CTRL/phase-4.contract.json`
   and `node $CTRL/launch-checklist.mjs $CTRL/phase-4.contract.json`.
4. If `curl -sS https://api.deepseek.com/user/balance -H "Authorization: Bearer $DEEPSEEK_API_KEY"`
   says `is_available: true`, add the `deepseek-pro` judge runtime (see `phase-2b.contract.json`
   for the exact runtime block, `sandbox: read-only`) and set each node's `gate` to
   `{ "enabled": true, "review": "advisory", "runtime": "deepseek-pro", "failOn": ["major","critical"], "maxRevisions": 1, "requiredCapabilities": {} }`.
   Otherwise keep `gate: false` (Anthropic-only; a same-vendor judge is forbidden).
5. Launch: `sh $CTRL/launch-phase.sh $CTRL/phase-4.contract.json intent-factory-lean-p4-release-20260908 $CTRL/controller-p4 $CTRL/preflight-p4.json`
   then `node $CTRL/launch-checklist.mjs $CTRL/phase-4.contract.json` again (preflight now exists).
   The graph: `runner-split` first (alone), then `docs-v03` and `metrics-v03` in parallel
   (`dependsOn: runner-split`, `maxParallel: 2`).
6. Arm a watcher: `node $CTRL/watch-campaign.mjs /Users/frb/dev/frb/skills intent-factory-lean-20260905 30000`
   prints one line per actionable change (run terminal, node attention, orphan, 20 min idle) and
   nothing for progress. Act only on those lines. `campaign watch --wake` exists on the new
   runner too but the control script is proven.
7. Record a `campaign note --kind outcome --run-id <run>` with pids and the run ref at launch,
   using the snapshot runner: `node $CTRL/controller-p4/.../runner.mjs campaign note intent-factory-lean-20260905 --cwd /Users/frb/dev/frb/skills --session-id <your session> --kind outcome --text "..."`.

## When a node ends

- **done**: the run ref `refs/intent-factory/<run>/run` moved. Land it:
  `git cherry-pick <ref tip>` then `git -c core.hooksPath=.husky commit --amend -m "<conventional message>"`.
  Check `git ls-tree HEAD node_modules` is empty (the seal now excludes the link; older sealed
  commits carried it). **Assert `git status --short` is empty after every commit** — commitlint
  refuses silently inside chained commands and two takes were launched from the wrong base.
- **failed on verification with the work green** (environmental: 600 s ceiling, node_modules,
  racy test): adopt the worktree diff —
  `W=.runs/worktrees/<run>/<node>.1; git -C $W add -A -- . && git -C $W rm -r -q --cached --ignore-unmatch -- .runs node_modules && git -C $W diff --cached --binary > /tmp/p.patch && git apply /tmp/p.patch`,
  run check, typecheck, the full suite, then commit with a message that says it was adopted.
- **failed with the work incomplete**: `resume --detach <run-dir>` re-dispatches attempt N+1
  continuing from attempt N's sealed sha (landed in 2b, first exercised in phase 3? no — not
  yet exercised in the field; watch it).
- **protocol_failure**: read `<run-dir>/results/<node>.json`; the usual causes are a missing
  file (the worker ended its turn) or more than 32 `changedFiles`.
- **blocked/attention with `exhaustedUntil`**: provider allowance; resume after the instant.

## Phase close routine (every phase)

Full suite in the installed checkout: `INTENT_FACTORY_NOTIFY_BIN=/usr/bin/true npm test`
(about 12 minutes; the variable keeps any stray notification off the desktop). Review the
diff. Commit (Conventional Commits, body lines ≤ 100 chars). Scan the new range for secret
patterns (the repo is public). `git push origin campaign/lean-v03`. Outcome note in the
journal. Refresh the controller snapshot for the next phase.

## Campaign close (after phase 4)

Per spec section 5 row "close": bump `INTENT_FACTORY_VERSION` in `scripts/drivers/index.mjs`
and `package.json` to 0.3.0; write the retrospective under `docs/intent-factory/`
(`RETROSPECTIVE-2026-09-08.md`: what shipped, the field defects listed below, per-phase costs
from the journal, section-6 indicators from `metrics intent-factory-lean-20260905 --json`);
`campaign close intent-factory-lean-20260905 --cwd /Users/frb/dev/frb/skills`; commit; push;
open the PR from `campaign/lean-v03` to `main` if the owner wants one. The managed signal block
in AGENTS.md is rewritten by the runner.

## Open issues for the retrospective (all recorded in the journal)

- Phase 1 was pushed without the full suite (60 failures); three suite-fix takes.
- Sonnet rotation at 600 turns discarded worktrees (deleted in 2a).
- `sealAttempt` could never seal a real attempt (`:(exclude).runs` + `advice.addIgnoredFile`);
  no node integrated through the runner before 2026-09-08 17:45Z.
- Headless workers that "pause to wait" end their session; `npm install` in a worktree fails
  the snapshot; `changedFiles` > 32 is a protocol failure; the 600 s verification ceiling.
- The seal committed the `node_modules` symlink; cherry-picking it destroyed the checkout's
  real `node_modules` (restored with `npm ci`). Fixed in `88064c4`.
- Notify receipts: `no_transport` (env file without `export`) then `failed: eventId is
  invalid` (Ford adapter); fixed in `88064c4` — phase 4 should be the first run with
  `delivered` receipts. Verify in `<run-dir>/notify.jsonl`.
- `processStartToken` is `null` in `controller.lock` on this macOS, so pid reuse is not
  detected.
- `lease-liveness.mjs` survives (imported by runner.mjs bootstrap helpers and store.mjs).
- DeepSeek balance negative since 06:00 BRT; judges suspended; Anthropic-only with `gate: false`.
- Judge review never ran on any node after phase 1 (advisory judge unreachable or disabled);
  the spec's blocking-judge first-pass indicator has no data.
- Orchestrator process defects: chaining past failed commits (twice); running the full suite
  with notifications enabled spammed the desktop (fixed by the helpers default and the env var).

## Files that matter

- Contracts and preflights: `.runs/control/intent-factory-lean-20260905/phase-*.contract.json`, `preflight-*.json`.
- Snapshots: `controller-p2a` (0657afa), `controller-p2b` (e6933c3), `controller-p3` (f39fcca); make `controller-p4`.
- Control scripts: `launch-phase.sh`, `launch-checklist.mjs`, `watch-campaign.mjs`, `PHASE-AUTHORING.md` (rules), this file.
- Runs: `.runs/intent-factory-lean-p*` (take dirs), worktrees under `.runs/worktrees/`, retained for inspection; safe to leave.
- Spec: `docs/intent-factory/TECH-SPEC-2026-09-05-lean.md` (revision 5; section 10 has the Astra rounds; the 2026-09-08 field defects are only in the journal so far).

## Update 2026-09-08T19:40Z — phase 4 is RUNNING

The same session launched phase 4 after the handoff (the session goal was to finish the campaign
and no other harness had attached). Run `intent-factory-lean-p4-release-20260908-take2`,
controller pid 20372, snapshot `controller-p4` (88064c4), run ref 88064c4, Sonnet workers with an
advisory `deepseek-v4-pro` judge (the DeepSeek balance came back). The detached controller
survives this session. **Do not relaunch phase 4.** To take over: `node .runs/control/intent-factory-lean-20260905/controller-p4/skills/mine/intent-factory/scripts/runner.mjs status .runs/intent-factory-lean-p4-release-20260908-take2`;
if the controller is dead with non-terminal nodes, `... resume --detach <run-dir>`; when the run
is terminal, land the run ref (`refs/intent-factory/intent-factory-lean-p4-release-20260908-take2/run`)
as described in "When a node ends", run the full suite, push, then the campaign close routine.

## Update 2026-09-08 20:0xZ — phase 4 canceled here; continue from another machine

The owner is closing this session and continuing from another machine, so the phase-4 run
launched above (`intent-factory-lean-p4-release-20260908-take2`) was **canceled after ten
minutes with no diff**; nothing from phase 4 landed. `.runs/` is machine-local and git-ignored,
so everything the next harness needs was copied into the repository under
`docs/intent-factory/campaigns/intent-factory-lean-20260905/` (`control/`: contracts,
`launch-checklist.mjs`, `launch-phase.sh`, `watch-campaign.mjs`, `PHASE-AUTHORING.md`, this
runbook; `campaign/`: `journal.jsonl`, `campaign.json`, rendered `HANDOFF.md`).

To continue on the other machine:

1. `git clone git@github.com:feliperun/skills.git && cd skills && git checkout campaign/lean-v03 && npm ci`.
2. Restore the campaign state: `mkdir -p .runs/campaigns/intent-factory-lean-20260905 .runs/control/intent-factory-lean-20260905`,
   copy `docs/intent-factory/campaigns/intent-factory-lean-20260905/campaign/{journal.jsonl,campaign.json}`
   into `.runs/campaigns/intent-factory-lean-20260905/` and the whole `control/` folder into
   `.runs/control/intent-factory-lean-20260905/`. Then `node skills/mine/intent-factory/scripts/runner.mjs campaign show intent-factory-lean-20260905 --cwd "$PWD"`
   must render the handoff, and `campaign attach` the new session.
3. Replace the machine-specific absolute paths in the copied control files: every
   `/Users/frb/dev/frb/skills` → the new checkout path (contract `cwd`, `launch-phase.sh`
   `REPO`, `watch-campaign.mjs` usage) and every `/Users/frb/.asdf/installs/nodejs/26.8.1/bin/node`
   → `$(command -v node)` resolved to a real binary (contracts' verification argv,
   `launch-phase.sh` `NODE`). Node ≥ 22 is required; the suite was measured on 26.8.1.
4. Environment: `claude` CLI logged in (Sonnet workers), `DEEPSEEK_API_KEY` exported
   (deepseek-v4-pro judge; balance was positive at 19:5xZ), optionally the Ford notify env
   (`INTENT_FACTORY_NOTIFY_BIN` exported) — without it receipts say `no_transport`, which is fine.
   `npm test` (about 12 minutes) must be green before launching: 492 tests, 490 pass, 2 skipped at 88064c4.
5. Launch phase 4 exactly as "Next step: phase 4" says (snapshot `controller-p4` from HEAD,
   validate with it, checklist, `launch-phase.sh`, watcher, journal note). The contract already
   carries the `deepseek-pro` advisory judge on every node; drop it back to `gate: false` only if
   the DeepSeek balance is gone again.
6. Then the phase close and the campaign close routines above. When the campaign closes, copy
   the final `journal.jsonl`/`HANDOFF.md` back into the docs folder so the history is in git.
