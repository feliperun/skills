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
This includes a candidate whose SHA equals the previous run-ref tip.
