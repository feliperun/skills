# Intent Factory operations

## Attempt worktrees

An execution repository is a git work tree with at least one commit. A run
creates the integration head `refs/intent-factory/<run-id>/run` at the
recorded source `gitHead`. Every worker attempt gets a linked worktree at
`.runs/worktrees/<run-id>/<node-id>.<attempt>` on branch
`if/<run-id>/<node-id>/<attempt>`, cut from that ref. The node snapshot
records `worktree.path`, `.branch`, `.baseSha`, and the sealed `.commit`.
Provider processes, scope snapshots, controller verification, and judges all
use that path; `contract.cwd` stays the home of run/control artifacts. When
the repository root has an installed `node_modules`, every attempt worktree
links it in as a symlink, never a copy.

A retried attempt never discards the previous one's edits: the controller
seals the previous attempt's worktree first, and when that seal has a diff,
the next attempt is cut from that sealed sha (`worktree.previousAttempt`
records which) instead of the run ref tip; an empty seal falls back to the
run ref tip.

`contract.maxParallel` bounds concurrent nodes; each tick the scheduler
dispatches every `pending` node whose dependencies are `done`, up to the free
slot count, each into its own worktree. Integration stays serialized
regardless of `maxParallel`.

## Integration transaction

The controller serializes integration. It seals any uncommitted attempt
edits with a commit naming the run/node/attempt (`empty: true` in the
journal when there is no diff), appends a `prepared` record to
`integration.jsonl` (node, attempt, attempt sha, previous run-ref tip,
candidate sha, verification evidence) before creating anything, and builds
the candidate — fast-forward or merge — on
`refs/intent-factory/<run-id>/candidate` /
`.runs/worktrees/<run-id>/.candidate`. Node `verification` runs once there. A
pass advances the run ref with a conditional `update-ref` and makes one node
state write to `done` with `integratedHead`. A failed candidate removes the
candidate ref/worktree, leaves the run ref untouched, and keeps the attempt
worktree. A conflict marks the node `attention` with the conflicting paths
and cleans the scratch worktree.

Resume replays `integration.jsonl`, never ancestry, to identify the one
unfinished transaction and complete it idempotently (including an accepted
no-change candidate). A resume that re-dispatches a failed/stalled/
exhausted/canceled node cuts the next attempt from the previous attempt's
sealed sha, the same continuation rule as any other retry.

## Controller lock and takeover

One controller drives a run, holding `<run-dir>/controller.lock`: `{pid,
processStartToken, startedAt, hostname}`. Acquisition is an exclusive
create; there is no TTL. A contender treats the lock as stale only once it
can prove the holder dead — the pid is gone, or its process start token no
longer matches (pid recycled); anything short of that is `controller_active`
and the contender exits untouched.

Takeover renames the lock file aside, re-checks the captured record is still
stale, then discards it and installs its own; if the captured record turns
out live (a race), the capture is handed back under its original name.
Worker/judge/verification children run detached in their own process group,
so before dispatching anything new, `resume`'s recovery pass terminates
(`SIGTERM` then `SIGKILL`, same as `cancel`) every invocation recorded for a
`running` node — unless it is still inside its deadline, in which case it is
adopted and its result read instead of thrown away. `cancel <run-dir>`
signals a live controller to death first, so its own takeover never waits on
an expiry.

## Runtime discovery

`doctor --discover [--json]` performs mutation-free harness discovery,
reporting `{available, exhaustedUntil, reason}` per runtime (missing CLI →
`not_found`; auth failure has no reset; quota keeps its reset, including
Z.ai code 1310). Omitted `runtimes`/`runtimeDefaults` are composed once and
persisted in `routing.assignments`; exhaustion re-tiers within the current
tier only, otherwise the node parks `attention` with
`runtime_tier_exhausted`. See [contract.md](contract.md) for the failover
edge and vendor rules.

## Status

`<run-dir>/status.json` (`status --json`'s payload: `schemaVersion`, `run`,
`contractId`, `campaignId`, `goal`, `usage`, `controller` state, `summary`,
and one `nodes[]` entry per node — id, status, phase, runtime, continuation
mode, attempt, revisions, usage, cost, verdict, note, `scopeFindings`,
`errorCode`, `blockedBy`) and `.runs/status.json` (a ≤1 KiB pointer:
`schemaVersion`, `runId`, `campaignId`, `state`, `checkpoints`, `activeNode`,
`runtime`, `elapsedSec`, `costUsd`, `needsYou`, `attention`, `generatedAt`
unix seconds) are written atomically every controller tick and at run
terminal. `status <run-dir>` renders, in order: Needs you (attention nodes
and orphans), Now (active node, elapsed, cost, or idle), Nodes (one row per
node), Cost (run totals). `statusline/claude-code.sh` reads the pointer
directly for an ambient one-line prompt segment.

## Dashboard

`node dashboard/dashboard.mjs [--port 4173] [--cwd <repo>]` serves a
read-only page on `127.0.0.1:4173`, one column, SSE-refreshed, over
`status.json`, node JSON, `events.jsonl`, `usage.jsonl`, `notify.jsonl`, and
`HANDOFF.md` only — it never writes campaign state. Sections: a campaign
picker; **Now** (active run/node/cost or idle); **Needs you** (one line per
attention item with the resolving command); **Runs** table for the selected
campaign; a **Run drawer** on row click with per-node tabs (log tail,
verification, diff, findings, prompt); **Handoff** (the campaign's
`HANDOFF.md`). The snapshot is bounded to 200 KiB, shrinking the open
drawer's log/verification tails, then its prompt, then the handoff text.

## Notify

On `node.terminal`, `run.terminal`, and `attention` the controller renders a
one-line message from counters and identifiers only (node id, run id, state,
attempt, error code, done/total — never model text), calls the executable
named by `INTENT_FACTORY_NOTIFY_BIN` with that event as JSON on stdin, and
appends a receipt (`delivered`, `failed`, or `no_transport`, with the
timestamp) to `<run-dir>/notify.jsonl`. Exit 0 is the only success signal;
anything else retries on a later tick, up to three attempts with backoff
(`INTENT_FACTORY_NOTIFY_BACKOFF_MS` overrides it). With
`INTENT_FACTORY_NOTIFY_BIN` unset nothing is spawned and the receipt is
`no_transport`. `INTENT_FACTORY_NOTIFY_BIN=os-macos` opts into the bundled
`osascript` adapter; any other value is an executable path. A resume never
re-sends a notification already recorded in `notify.jsonl` for the same
node, attempt, and outcome.

## Campaigns

Every contract requires `campaignId`; campaign state lives at
`.runs/campaigns/<campaign-id>/` (`campaign.json`, `journal.jsonl`,
`HANDOFF.md`) and can link multiple runs.

```bash
node scripts/runner.mjs campaign list [--cwd <dir>]
node scripts/runner.mjs campaign init <id> --cwd <dir> --goal "Goal"
node scripts/runner.mjs campaign attach <id> --cwd <dir> --tool codex --session-id <s> \
  --transcript <path> --format jsonl [--cursor <c>]
node scripts/runner.mjs campaign note <id> --cwd <dir> --session-id <s> \
  --kind <intent|decision|supersede|constraint|outcome|next|open-question|retrospective> --text <t>
node scripts/runner.mjs campaign resolve <id> --cwd <dir> --session-id <s> --question-id <q> --text <a>
node scripts/runner.mjs campaign sync <id> --cwd <dir> --session-id <s>
node scripts/runner.mjs campaign ack <id> --cwd <dir> --session-id <s> --event-id <e>
node scripts/runner.mjs campaign watch <id> --cwd <dir> --wake
node scripts/runner.mjs campaign close <id> --cwd <dir>
node scripts/runner.mjs campaign show <id> --cwd <dir>
```

`sync` is the user-pull read: campaign header, the newest linked run's
`status.json` summary, and unseen journal events (≤8000 bytes) after the
session's durable cursor, without moving it. `ack` is the only cursor
writer, keyed by the journal's own event id. `watch --wake` polls every
linked run's `status.json` every 30s and prints one line per actionable
change (a run gone terminal, a node in attention, a stale controller lock,
or twenty idle minutes), exiting once the campaign is closed. `close`
refuses until a `retrospective` note exists; a closed campaign rejects
further attach/note/resolve writes but stays inspectable via `show`/`list`.
The campaign also mirrors its active state into a managed
`<!-- intent-factory-active:start -->` block at the bottom of the target
repo's `AGENTS.md` (read-only for any agent; the runner rewrites it at run
start/end, resume, and cancel) — the signal that active work exists before
an unrelated session's first prompt.

`HANDOFF.md` is an atomic, ≤16 KiB projection of recent intents, decisions,
constraints, outcomes, next action, and open questions, refreshed on
initialization, run registration, state transitions, `status`, and terminal
completion; `journal.jsonl` is the append-only, fsynced full narrative.
