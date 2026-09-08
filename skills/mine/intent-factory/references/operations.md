# Intent Factory operations

## Isolated attempts

An execution repository must be a Git work tree with at least one commit.
When a run starts, the controller records its source identity and creates:

```text
refs/intent-factory/<run-id>/run
.runs/worktrees/<run-id>/<node-id>.<attempt>
if/<run-id>/<node-id>/<attempt>
```

The run ref is the only integration head. Each attempt branch starts there,
and the node snapshot records its path, branch, base SHA, and current commit.
Provider commands, snapshots, verification, progress monitoring, capsule
capture, and judge inspection receive the attempt path as their cwd. The run
directory remains the home for state, logs, journals, and control artifacts.

A retried attempt never discards the previous one's edits: the controller
seals the previous attempt's worktree first, and when that seal carries a
diff, the next attempt's branch and worktree are cut from that sealed sha
instead of the run ref tip, with `worktree.previousAttempt` recording which
attempt it continues. A previous attempt that sealed empty falls back to the
run ref tip, as before. When the repository root has an installed
`node_modules`, every attempt worktree links it in as a symlink, never a
copy.

The worker-result prompt points at the attempt-local `.runs/results` sidecar.
After the worker closes, the controller copies that JSON into the canonical
run-directory result path. The sidecar is excluded from attempt commits.

## Concurrency

`contract.maxParallel` bounds how many nodes run at once. Each tick the
scheduler dispatches every `pending` node whose dependencies are `done`, up to
the free slot count (`maxParallel` minus nodes currently running), each into
its own attempt worktree and branch. Integration stays serialized regardless
of `maxParallel`: only one candidate is built, verified, and considered for
the run ref at a time, so a second node that finishes while the first is
integrating waits its turn and its candidate is rebuilt on the accepted head.

## Integration transaction

The controller serializes integration. It seals any uncommitted attempt edits
with a commit message containing the run, node, and attempt. A clean or
already-committed attempt is valid; its journal record carries `empty: true`
when it has no diff from its base.

The controller appends a `prepared` integration record before creating the
candidate ref or scratch worktree. The record identifies the node and attempt,
attempt SHA, previous run-ref tip, candidate SHA, and attempt verification
evidence. The candidate is a fast-forward of the run ref when possible, or a
merge candidate otherwise, at:

```text
refs/intent-factory/<run-id>/candidate
.runs/worktrees/<run-id>/.candidate
```

The node verification runs once in that candidate worktree. A passing result
advances the run ref with `git update-ref <ref> <candidate> <previous>` and
then makes one node state write to `done` with `integratedHead`. A failed
candidate removes the candidate ref and scratch worktree, leaves the run ref
untouched, and retains the attempt worktree. A merge conflict records its
paths, marks the node for attention, cleans the scratch worktree, and retains
the attempt.

## Recovery

Resume uses `integration.jsonl` to identify the unfinished transaction. It does
not infer verified work from ancestry. Preparation failures clean and rebuild
the candidate deterministically; a verified transaction reuses its recorded
candidate evidence. Recovery handles the conditional ref move, the done-state
write, worktree removal, and terminal event as separate idempotent effects.
This includes a candidate whose SHA equals the previous run-ref tip. A resume
that re-dispatches a failed, stalled, exhausted, or canceled node retries it
in place through the same continuation rule as any other retry: the next
attempt is cut from the previous attempt's sealed sha, not a fresh worktree
from the run ref.

## Controller lock and takeover

One controller drives a run at a time, holding `<run-dir>/controller.lock`:
`{pid, processStartToken, startedAt, hostname}`. Acquisition is an exclusive
create; there is no TTL and nothing to renew, so a lock stays valid for as
long as its holder is alive, however long that takes. A contender that finds
the file held reads it and treats it as stale only when it can prove the
holder dead — the recorded pid is gone, or its process start token no longer
matches the live process at that pid (the pid was recycled). Anything short
of that proof is `controller_active`, and the contender exits without
touching the run: two controllers must never dispatch the same node.

Takeover is a capture-and-verify sequence, not a delete-and-write: the
contender renames the lock file aside (one atomic step, so a live successor
that installed in the gap is never destroyed), re-checks that the captured
record is still stale, and only then discards it and installs its own record.
If the captured record turns out to be live after all — a second contender
raced it and won — the capture is handed straight back under its original
name and this contender's attempt fails.

Worker, judge and verification children run detached in their own process
group, so a dead controller's dispatches keep running orphaned unless
something reaps them. Before `resume` dispatches anything new, its recovery
pass walks every node that was `running`: past-deadline or otherwise unusable
invocations are terminated by process group (`SIGTERM`, then `SIGKILL`) —
the same termination `cancel` uses — and only once that pass completes does
the scheduler loop start handing out new work. A live invocation still inside
its deadline is adopted instead of killed: the pass waits for it and reads
its completed result rather than throwing away work a `resume` merely
happened to interrupt.

`cancel <run-dir>` takes the same path deliberately: it signals a live
controller to death first, so by the time it calls the same takeover its own
lock acquisition is never waiting on an expiry — the lock is already stale
the instant the pid is gone.

## Runtime discovery

`doctor --discover [--json]` performs mutation-free driver discovery and
reports `{available, exhaustedUntil, reason}` per runtime. Missing CLIs are
`not_found`; authentication failures have no reset; quota responses retain
their reset time, including Z.ai code 1310. Omitted assignments are composed
once and persisted in `routing.assignments`; exhaustion re-tiers only within
the current tier and otherwise leaves the node in attention with
`runtime_tier_exhausted`.

## Status

`<run-dir>/status.json` (the same payload `status --json` prints) and
`.runs/status.json` (a bounded pointer to the active run) are written
atomically every controller tick and at run terminal — the progress surface
now that there is no heartbeat. The per-run file carries `schemaVersion`,
`run`, `contractId`, `campaignId`, `goal`, `usage`, `controller` (state, pid,
since), `summary`, and one entry per node (`id`, `status`, `phase`, `runtime`,
`attempt`, `revisions`, `note`, `errorCode`, `blockedBy`, …). The `.runs`
pointer is smaller — `schemaVersion`, `runId`, `campaignId`, `state`,
`checkpoints`, `activeNode`, `runtime`, `attention`, `generatedAt` (unix
seconds) — bounded to 1 KiB for a cheap ambient read; `statusline/claude-code.sh`
reads it directly.

## Notify

On `node.terminal`, `run.terminal` and `attention` the controller renders a
one-line message from counters and identifiers only (node id, run id, state,
attempt, error code, done/total — never model text), calls the executable
named by `INTENT_FACTORY_NOTIFY_BIN` with that event as JSON on stdin, and
appends a receipt (`delivered`, `failed`, or `no_transport`, with the
timestamp) to `<run-dir>/notify.jsonl`. Exit code 0 is the only success
signal; anything else is `failed` and retried on a later controller tick, up
to three attempts total with backoff (`INTENT_FACTORY_NOTIFY_BACKOFF_MS`
overrides the default). With `INTENT_FACTORY_NOTIFY_BIN` unset nothing is
spawned and the receipt is `no_transport` — there is no implicit desktop
fallback. Progress never notifies. Setting
`INTENT_FACTORY_NOTIFY_BIN=os-macos` is the one explicit opt-in to the bundled
`osascript` adapter; every other value is treated as an executable path.
Resuming a run never re-sends a notification already recorded for the same
node, attempt, and outcome: the durable `notify.jsonl` is the only thing that
survives the controller process boundary, so it is what a fresh resume checks
before enqueuing.
