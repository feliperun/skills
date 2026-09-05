# Release 1

What release 1 added, and where each surface lives. The
[SKILL.md](../SKILL.md) router names the commands a session invokes; this file
carries the behaviour behind them. Deeper specifications stay in
[campaign-autonomy.md](campaign-autonomy.md), [feedback.md](feedback.md),
[contract.md](contract.md), and [routing.md](routing.md).

## Ambient liveness at zero token cost

`scripts/heartbeat.mjs` derives `.runs/campaigns/<id>/heartbeat.json` from the
newest `liveness` fact in the campaign journal: a bounded read cache (1 KiB,
`schemaVersion: 1`), rewritten atomically after a successful fact write and
rebuildable from the journal alone. Its state is one of `running`,
`waiting_gate`, `blocked`, `paused_quota`, `done`, `failed`.

Claude Code's `statusLine` command reads that file locally on a timer, so the
human at the keyboard sees campaign liveness without spending a token. The
control session is woken only by an event with `requiresUser: true`. Details
and the full channel table: [feedback.md](feedback.md).

## Projected outbox, pull-only sync and ack

The durable outbox (`scripts/outbox.mjs`) is a projected record bounded to 100
events, with coalescing and oldest-eviction under pressure.

- `campaign sync <id> --cwd <repo> --session-id <s>` is the user-initiated
  read: it attaches the session, renders the heartbeat digest, and returns the
  unseen events after that session's `session-<session-id>` cursor without ever
  moving it. The factory never invokes it for progress.
- `campaign ack <id> --cwd <repo> --session-id <s> --event-id <e>` advances the
  cursor. Only an event still retained in the outbox can be acknowledged;
  coalesced or evicted ids are rejected.

The supervisor also projects `governance-metrics.json` from event, journal and
outbox timestamps. Transition table and authority:
[campaign-autonomy.md](campaign-autonomy.md).

## Protocol schema 2: a Definition of Done item declares its own proof

`scripts/definition-of-done.mjs` accepts only objects:
`{ id, text, proof?: { kind: "command"|"path", ref }, judgment?: true }`. An
item is proven mechanically by a verification `command` or a workspace `path`,
or it is marked for judge `judgment`. The schema-1 string item is rejected —
there is no converter and no dual acceptance.

## Conditional judge and the cited-item protocol

`scripts/judge-gate.mjs` gates deterministic items first: the controller runs
every `proof` and spends no judge invocation until they pass. A contract whose
items are all mechanically proven never invokes a judge at all.

The judge arbitrates `judgment` items only. A gate-failing rejection whose
findings cite no judgment item id is a judge protocol failure, not a worker
failure: it earns one bounded re-ask and then blocked attention, and it never
consumes a worker revision.

## Contract-level finalVerification

`contract.finalVerification` (`scripts/final-verification.mjs`) carries the
full verification-command schema and is the proof that the phase as a whole
closes. The controller runs it before the judge on the phase-terminal node —
the node no other node depends on — and on any `targetedFix` node, so no final
checkpoint is approved on partial verification.

## contract prune

```bash
node <skill-dir>/scripts/runner.mjs contract prune <run-dir> --out <file> [--id <contract-id>] [--targeted-fix]
node <skill-dir>/scripts/runner.mjs contract validate <contract.json>
```

`prune` turns a partially finished run into the contract for what is left of
it: drop the settled nodes (`done` and `no-op`), keep the rest with their
`dependsOn` rewritten to the survivors, and seed every survivor with the
portable capsule its last attempt left behind. A pruned contract with one node
left is by definition a targeted fix, so it is written only with
`--targeted-fix` and stamped `targetedFix: true`; `validate` refuses any other
single-node contract.

## Deterministic resilience

- **Failover synthesis** (`scripts/failover.mjs`). A contract that declares
  `runtimeRules` owns its routing outright and nothing is synthesized behind
  it. A contract that declares none gets an implicit chain of the remaining
  healthy runtimes ordered by `costRank`, cheapest untried first, unranked
  last, ties by declaration order. Synthesis is worker-only: a judge without a
  declared rule stays on its gate runtime, so a verdict is never quietly
  arbitrated by a model the contract did not name. Edges are cycle-checked.
- **Quota-reset scheduling** and **network backoff** (`scripts/backoff.mjs`).
  A dropped socket is the network's problem and the warmed runtime is still the
  cheapest place to finish: wait, then ask it again. A provider that cannot
  hold the result protocol is classified as a protocol failure instead: change
  provider, or stop and say so. The decisions are pure; persistence stays in
  `runner.mjs`.
- **Single-winner lease takeover** (`scripts/lease-liveness.mjs`). An expired
  lease is not proof that its holder died — a slow disk or a suspended laptop
  produces a late heartbeat from a live controller. Adoption requires proof of
  death: the recorded pid is gone, or its process start token no longer matches
  the one recorded when the lease was written.
- **Environment preflight** (`scripts/env-preflight.mjs`). Free disk, a
  functional git, the worktree state, and every routed runtime binary present
  and versioned are checked before the first dispatch and again by `doctor`. A
  failing gate leaves the run materialized and resumable: the report is
  recorded as run evidence and the controller stops, so the host is fixed and
  the run resumed instead of paying for the finished nodes twice. A merely
  dirty worktree is advisory; set `INTENT_FACTORY_REQUIRE_CLEAN_WORKTREE=1` to
  make any dirt fatal.

## Metrics projector, CLI and the release-1 eval set

```bash
node <skill-dir>/scripts/runner.mjs metrics <campaign-id> [--cwd <dir>] [--json]
```

`projectMetrics` (`scripts/metrics.mjs`) is one pure function over the four
recorded sources of a campaign — the run `events.jsonl`, `usage-ledger.json`,
the notification outbox and the campaign journal — returning every release-1
indicator in one object, so effectiveness (`firstPassGateRate`,
`ambientCoverage`) and efficiency (`weightedPerClosedCheckpoint`,
`takesPerClosedCheckpoint`) are always reported together. It takes parsed
records and never a filesystem path. Each indicator carries its value, the
direction that counts as better, and the number of records it was computed
from; an indicator with no supporting record is `null`, never `0`.

A campaign is measured in two units that are not interchangeable: a *take* is
one operator dispatch at a checkpoint (one linked run the controller did not
generate as a repair), while a *worker dispatch* is one transition into
`running` inside such a run. The report prints both counts.

The eval set (`scripts/metrics-evals.mjs`) is the measured half: the
per-runtime worker preamble, measured by `preflight --json` sending one trivial
prompt through every routed runtime from an empty repository under exactly the
flags a run uses and recorded per run as `preflight.json`; the control-session
cost of the notification outbox, which the pull-only contract keeps at whatever
the `requiresUser` records alone cost; and the liveness series behind heartbeat
staleness and ambient coverage.
