# Authoring a phase contract for this campaign

Every rule here was paid for. Do not author a contract from memory; author it
from this file, then run `launch-checklist.mjs`, then `validate`, then a
targeted Astra round, then `preflight`, and only then launch.

## Operating block — identical in every phase, never re-derived

```json
"maxParallel": 1,
"stallTimeoutSec": 2400,
"timeoutSec": 7200,
"runtimeRules": [ { "match": {"role":"worker","currentRuntime":"<never-a-worker>"}, "runtime": "<any>" } ]
```

and on **every** node:

```json
"timeoutSec": 7200,
"progressPolicy": { "graceSec": 7200, "intervalSec": 300, "maxDryHeartbeats": 12 }
```

- `progressPolicy` is mandatory and explicit. An autonomous packet that omits it
  inherits `{300, 120, 3}`, which counts only file changes: a worker reading
  code or running a foreground test for six minutes is "stalled". This killed
  take 1 of phase 0 and was silently reintroduced into phase 1 until Astra
  round 4 caught it. `graceSec` equals the node timeout.
- `stallTimeoutSec` is 2400, never 900. `glm-5.3-flash[1m]` went silent for
  971 s on a long context while healthy and was killed twice at 900 s.
- `runtimeRules` is never `[]`. An empty rule set re-enables failover synthesis
  across every declared runtime, which put an OpenAI worker under an OpenAI
  judge in the phase-1 draft. One unreachable rule suppresses it.
- Declare only runtimes the phase actually uses. `preflight` probes every
  declared runtime, and an exhausted provider fails the whole preflight.

## Packet rules

1. **Tell the worker to run the command proofs before it finishes.** The
   controller runs `proof: {kind: "command"}` entries at the gate, and the
   standard "run only the declared verification commands" line actively tells
   the worker *not* to run them. Phase 1 attempt 1 died on four `tsc` errors in
   a file the worker never typechecked — one full revision, about 40 minutes.
   The instruction is: *before you declare the work done, run every command
   proof in the Definition of Done (`npm run check`, `npm run typecheck`) in the
   foreground and fix what they report.*
2. No background commands, no task tools, no sleep loops. Output bounded with
   `| tail -n 200`. Never the full `npm test` — the orchestrator runs it at
   phase close.
3. State the tree's real condition, including what the previous attempt left
   broken, verbatim.
4. "Keep your context small: read by offset or grep, never whole large files."
   `runner.mjs` is over 7000 lines.
5. Packets forbid writing `.runs/control` and `.runs/campaigns`, never the
   canonical result file the controller designates.
6. A retried attempt is always a **fresh** invocation. Never reuse a provider
   session after a timeout or a kill: one returned success with zero turns, one
   produced no output for 900 s. The previous attempt's findings travel in the
   prompt, not through the provider session.

## Definition of Done

- Mechanical items are `npm run check` and `npm run typecheck` as command
  proofs; targeted tests are `verification` entries run by the controller.
- At most three judgment items, each naming an observable.
- A judgment item must be arbitrable from the diff and the recorded results
  alone. If the judge would have to run something to decide, it is a
  verification entry, not a judgment item.

## Phase close

Full suite → review the diff → commit (Conventional Commits) → **push** →
outcome note → refresh the controller snapshot. The repository is public: scan
any new range for secret patterns before its first push.

## Chaining

Phase 0 and 1 share one mutable tree, so their nodes are chained. That is not
free: of the 11 non-done node states in phase 0, **7 were `dependency_failed`**
— collateral damage from a sibling, the exact waste class this campaign exists
to remove. From phase 2a, attempt worktrees isolate nodes and edges are declared
only for real data dependencies. Until then, prefer re-launching a take with the
already-done nodes dropped over re-running the whole chain.

## Rules added on 2026-09-08 (phases 1f, 2a, 2b, 3) — each one cost a take

- **Schema 3 contracts** (from phase 2a): no `maxInputTokens`, `maxCostUsd`, `usagePolicy`,
  `progressPolicy`, `runtimeRules`. `launch-checklist.mjs` skips the progressPolicy check when
  `schemaVersion >= 3`. Validate with the snapshot runner you will launch with, never the tree.
- **Verification ceiling is 600 s per entry.** `runner.test.mjs` no longer fits in one entry
  (or in two); use four name-pattern splits `^r`, `^a`, `^[b-oB-O]`, `^[p-zP-Z]` plus
  `skills/mine/intent-factory/test/*.mjs`. Never put `test/*.mjs` (root) in controller
  verification: ci-policy needs commitlint from node_modules — the orchestrator runs it at close.
- **Absolute node binary** in every verification argv (`/Users/frb/.asdf/installs/nodejs/26.8.1/bin/node`).
- **Headless worker rules go in every packet**: never end the turn to wait; foreground
  commands with an explicit tool timeout under eight minutes; never `npm install`/`npm ci` in
  the worktree (husky prepare writes `.husky/_/.gitignore` → `snapshot_ignore_changed`);
  `changedFiles` ≤ 32 entries (protocol cap; a longer list is `protocol_failure`).
- **Sonnet rotation is gone** since phase 2a (the 600-turn rotation discarded worktrees); a
  Claude worker is bounded only by `timeoutSec`/`stallTimeoutSec`. Before 2a, checkpoint the
  old worktree's diff as a `chore(...): checkpoint` commit and relaunch a take from it.
- **Gate `none` while only one vendor is available.** DeepSeek has had no balance since
  2026-09-08 06:00 BRT (402); a same-vendor judge is forbidden, so nodes run with `gate: false`
  and the orchestrator reviews the diff plus the full suite. Restore `deepseek-v4-pro` as judge
  (read-only codex, `model_provider=deepseek`) once `GET https://api.deepseek.com/user/balance`
  says `is_available: true`.
- **Launching**: `launch-phase.sh <contract> <run-id> <controller-dir> <preflight.json>`; it
  sources the Ford env under `set -a` (the file assigns without `export`), runs preflight,
  `run --detach`, and `supervise --detach` only when the runner still has it (removed in 2b).
- **Landing**: a done node advances `refs/intent-factory/<run>/run`; land it with
  `git cherry-pick <tip>` and `git commit --amend` to a Conventional Commits message. **Assert
  a clean tree after every commit** — commitlint failures were chained past twice and two
  takes were launched from the wrong base.
- **Adopting a failed-but-green node** (verification failed on an environmental entry only):
  `git -C <worktree> add -A -- . && git -C <worktree> rm -r -q --cached --ignore-unmatch -- .runs node_modules`,
  `git -C <worktree> diff --cached --binary > patch`, `git apply patch`, full suite, commit.
- **Campaign commands** run from a controller snapshot whose schema matches the journal
  (the working tree runner may be mid-diet). Avoid backticks in `campaign note` text under zsh.
