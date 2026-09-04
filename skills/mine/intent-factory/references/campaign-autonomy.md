# Campaign autonomy reference

Campaign autonomy is the durable control plane above one or more intent-factory
runs. It is bounded policy-driven continuation, not an unattended authority
grant. The campaign supervisor reads only durable campaign state and pinned
run artifacts; it never needs an interactive model turn to decide whether a
run may continue.

## Durable plan

`campaign init` creates `.runs/campaigns/<campaign-id>/`. `campaign configure`
copies the initial contract and creates an immutable controller snapshot before
writing `plan.json`. The snapshot is content-addressed and read-only; a plan
cannot point at a changed controller.

The plan has this shape:

```json
{
  "schemaVersion": 1,
  "planVersion": "1.0.0",
  "campaignId": "feature-42",
  "goal": "Deliver feature 42",
  "initialRunContract": "contracts/feature-42.json",
  "controller": {
    "snapshotVersion": "v1",
    "snapshotPath": "controller-snapshots/v1",
    "contentHash": "<sha256>"
  },
  "authority": {
    "repairRoots": ["src"],
    "allowedVerification": [{ "argv": ["npm", "test"] }],
    "retryLimit": 1,
    "repairLimit": 1,
    "runtimeFailover": {
      "allowedRuntimes": ["luna", "sol"],
      "routes": [{ "from": "luna", "to": "sol" }]
    },
    "maxInputTokens": 900000,
    "maxCostUsd": null,
    "irreversibleActionsForbidden": true
  }
}
```

The authority object is validated and immutable for the campaign. Repairs may
use only `repairRoots`, `allowedVerification`, declared runtimes, and the
remaining retry/repair/budget allowance. A finding, worker result, provider,
or repair contract cannot enlarge it.

`control-state.json` is the exact-once ledger. It records the initial and
repair runs, retry and repair counts, action IDs, attention state, and campaign
status. An action is persisted as `pending` before its pinned child is started
and becomes `dispatched` only after the child readiness handshake succeeds.
Repeated supervisor passes therefore resume an incomplete action instead of
creating a second repair.

## Transition table

The supervisor classifies each observed run without provider or model input.
The first matching row wins. A runtime may declare several outgoing failover
routes: the supervisor walks all of them in configuration order, resumes on
the first one that has not been attempted yet, and reports exhaustion — with
the remaining-edge count the walk produced — only once every one of them has
been used.

| Evidence | Action | Bound |
| --- | --- | --- |
| Every node is `done` or `no-op` | complete | Emit one completion event and close the campaign projection |
| Controller is dead and the run is nonterminal | resume | Consume one retry; stop at `retryLimit` |
| Timeout or stall | resume | Consume one retry; then `attention` |
| Provider exhaustion with an unused declared route | resume | Use one declared failover edge; no gate revision is consumed |
| Provider exhaustion after every declared route was used | attention | No implicit provider or account change |
| Budget, scope, authority, permission, cancellation, or invalid state | attention | Human decision required |
| Verification/gate/context failure with a failed node | repair | Create one deterministic repair contract; stop at `repairLimit` |
| Live nonterminal controller | wait | The detached controller remains the owner |
| Anything else | attention | Fail closed |

Terminal attention is intentional. The supervisor does not retry forever, wake
an orchestrator, change credentials, merge, deploy, delete data, or perform an
irreversible action. Human intervention can create a new explicitly authorized
run or resolve the campaign through the normal control surface.

## Safety boundary

- The controller executable is resolved from the immutable snapshot, never
  from the mutable working tree after configuration.
- One campaign lease excludes concurrent supervisors. Each child run retains
  its own controller lease and readiness identity.
- Run and repair contracts are validated before dispatch. Repair write roots
  must be relative directories inside the contract working directory and are
  checked by the normal closed-scope gate.
- Repair evidence is a bounded JSON projection of the failed node. It is
  diagnostic input, not executable policy.
- Verification commands are copied from the plan and may not be supplied by a
  worker or finding.
- Retry, failover, repair, token, and monetary limits are persisted and
  charged across restarts. Provider continuation uses only a persisted
  explicit session ID and an exact runtime identity match.
- Notification delivery is advisory. A missing, failing, or unavailable
  notification transport never changes the campaign outcome.

## Budget governance

Per-node token budgets are cumulative weighted input budgets, not context-window
limits. New contracts must carry a versioned `budgetProfile`; the controller
derives and persists a `budgetDecision` from the profile, packet/preamble
measurement, runtime capacity, remaining phase/campaign allowance and reserves
for pending nodes and judges. A literal per-node number without that provenance
is invalid. Budget extension is granted only from unused allowance and only to
a node with observed progress.

When a budget boundary is reached, the controller activates one predeclared
continuation segment with the same packet hash, write scope and verification.
If none is authorized, it records attention and updates heartbeat and human
notification within one supervisor interval. Provider failover is used only
for provider-reported exhaustion; a local budget stop never silently changes
provider, invents a subnode or waits without liveness evidence.

## Notifications and progress

The durable outbox, its delivery transports and the pull cursors live in
`scripts/outbox.mjs`; `scripts/campaign-autonomy.mjs` is the controller that
produces the events and never owns their delivery.

Material node transitions are appended as `campaign.progress`; terminal
campaign events keep their existing event types. Every event in
`notification-outbox.json` is a projected record
(`scripts/events.mjs`, schema version 1) carrying a stable event ID, the
envelope `schemaVersion`/`type`/`campaignId`/`at`, a deterministic
`summary`, a fixed `next` phrase, an explicit boolean `requiresUser`, a
bounded `data` object, attempt count, delivery timestamp, and last error.
`summary` and `next` are rendered from fixed per-type templates using
counters (`done`/`total`, `attempt`, `revisions`) and identifiers (node id,
runtime id, error code) only — never model text (rule 6). `data` is bounded
to 512 bytes and the canonical JSON of the whole record to 1 KiB
(`summary` truncates first, then `data`). The persisted record — the
projected event plus its delivery envelope (`deliveredAt`, `attempts`,
`lastError`, `coalesceKey`) — is held to that same 1 KiB by
`boundEventRecord` on every enqueue, delivery mutation and retention write:
the envelope shrinks first (`lastError`, then the coalesce key) and the
summary last, so no event is dropped for carrying delivery metadata and no
mutation can grow a stored record past the ceiling. Duplicate event keys are
ignored.
Pending progress for the same run/node is replaced by its newest material
state, with a new state-specific event ID; delivered progress and terminal
events are never coalesced. Delivered entries are evicted first when the
bounded outbox is full; a new terminal event may then evict the oldest
pending progress event. Heartbeats and unchanged controller passes emit no
progress. The outbox retains at most 100 events. If all 100 remain
undelivered terminal events, new events are rejected with a warning;
`watch` reads do not acknowledge transport delivery or free capacity.

Every record carries `requiresUser: true` only for the three actionable
classes: a blocking question (`blocked_context`/`open-question`/the persisted
`context_missing` error code), provider exhaustion that settles with no
unused failover edge (for example `provider_exhausted`,
`provider_exhausted_without_declared_failover`, `quota_exhausted`,
`payment_required`), or `campaign.completed`. All progress, healthy terminal
and budget/attention records are `requiresUser: false`, so a healthy run
produces no wake until its own completion marker; nothing in a healthy run
ever requires the user.

These progress records are human-channel feedback only. Outbox coalescing and
retention do not authorize a control-session wake: the factory never wakes the
session for progress. A session wake is reserved for `requiresUser: true`
(blocking question, exhausted failover or campaign completion); `campaign
sync` is user initiated. Ambient liveness is rendered from the derived
`heartbeat.json` artifact described by Addendum 01, without API tokens.

Set `INTENT_FACTORY_NOTIFY_BIN` to an executable that accepts one JSON event on
stdin and exits zero on successful delivery. `campaign drain` retries pending
events. At-least-once delivery is expected: a transport may receive an event
again after a process crash, so consumers should deduplicate by `eventId`.
The repository contains no relay credentials, recipient details, or private
transport implementation.

When `INTENT_FACTORY_NOTIFY_BIN` is unset, `drain` falls back to the platform
notify adapters bundled with the controller (the macOS `osascript` adapter on
darwin, none elsewhere). Run-level attention events therefore reach a human
channel on the same machine without any transport configuration, while
`campaign.progress` events are never pushed by either delivery path.

`heartbeat.json` is a derived read cache, not a source of truth. Liveness
facts stay append-only in `journal.jsonl`; the heartbeat is rebuilt from the
newest journal fact and rewritten atomically as a compact, key-sorted file at
most 1 KiB. `readHeartbeat` tolerates a missing, stale or oversized file, and
`rebuildHeartbeat` reproduces the recorded file byte-identically from the
journal alone.

## Run liveness watchdog

Each supervised nonterminal run is checked once per supervisor interval for
stale liveness. The staleness threshold is 40 minutes by default
(`LIVENESS_STALE_SEC = 2400`, overridable with the
`INTENT_FACTORY_LIVENESS_SEC` environment variable when it parses to a
positive integer). A run is stale when none of its heartbeat progress,
heartbeat generation, or newest node snapshot update is newer than the
threshold.

A stale run emits one `run.attention` event whose dedupe key is
`<runId>:stale_liveness:<lastObservedAt ISO>` and records a `blocked` liveness
fact whose `lastProgressAt` is that last observed activity, so the stall is
visible within one supervisor interval and repeated passes in the same
staleness epoch add nothing to the outbox or the journal. The watchdog reads
only the run node snapshots and the campaign journal/outbox/heartbeat: it
works for a legacy campaign directory that has only `campaign.json`,
`journal.jsonl` and the run directory, with no `plan.json` or
`control-state.json`.

## Governance metrics

The supervisor writes `.runs/campaigns/<id>/governance-metrics.json`
atomically after each run pass. The projection is pure and deterministic and
derives only from event, journal and outbox timestamps and structured fields;
log prose is never parsed. All rates are numbers from 0 to 1 rounded to 4
decimals.

| Field | Meaning |
| --- | --- |
| `budgetDecisionAge` | seconds since the newest `budgetDecision` event of a nonterminal node, null when none |
| `budgetHeadroomAtDispatch` | mean `extensionAllowanceTokens` over decisions, null when none |
| `budgetExtensionRate` | `extension` actions divided by decisions |
| `continuationRate` | `continuation_activated` actions divided by decisions |
| `budgetAttentionLatencyP95` | 95th percentile of outbox `budget_attention` latency over the corresponding `budgetAction` attention event, null when none |
| `silentStallRate` | fraction of consecutive liveness facts of a nonterminal run whose gap exceeded the stale threshold with no `stale_liveness` or `budget_attention` event between them; hard target zero |

`campaign sync <id> --session-id <s>` is the user-pull read: it attaches the
session once per day when it is not attached yet, prints one status header
line (campaign id, status, attention), one heartbeat liveness line (or
`liveness: no heartbeat yet`), then the unseen outbox events after the
session's `session-<session-id>` cursor as `<at> <type> <summary>`, oldest
first, truncated so the whole output stays under 8,000 bytes with a final
`sync truncated: N more events` line when needed. Sync never writes the
cursor and is never invoked by the factory for progress. `campaign ack <id>
--session-id <s> --event-id <id>` is the only cursor writer: it atomically
advances the `session-<session-id>` cursor to a retained event (or a
previously acknowledged id, where repeating the same ack is a no-op) and
prints one confirmation line; acking an id that is neither retained nor
previously acknowledged is rejected. Cursor movement never regresses, and
acknowledging an older retained event leaves the cursor where it was.

`campaign watch --cursor <consumer-id>` also reads ordered unseen events and
atomically advances a durable cursor before writing its JSON response; the
same call then returns none until a new event arrives. It does not provide a
per-consumer acknowledgement/replay handshake. `campaign watch --since
<event-id>` is the stateless form and returns events after an ID that is still
retained in the bounded outbox; coalesced or evicted IDs are rejected. Exactly
one flag is required. An attached orchestrator session should consume its
`session-<session-id>` cursor through `campaign sync` and acknowledge with
`campaign ack`. This is durable incremental pull; unsolicited same-chat push
is impossible without a runtime bridge.

## Operational commands

All commands are public runner CLI operations and accept `--cwd <repo>`:

```bash
node <skill-dir>/scripts/runner.mjs campaign init <id> --cwd <repo> --goal "Goal"
node <skill-dir>/scripts/runner.mjs campaign configure <id> --cwd <repo> --contract <contract.json> --source-root <intent-factory-dir>
node <skill-dir>/scripts/runner.mjs campaign start <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign supervise <id> --cwd <repo> --detach --interval 30
node <skill-dir>/scripts/runner.mjs campaign status <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign drain <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign watch <id> --cwd <repo> --cursor <consumer-id>
node <skill-dir>/scripts/runner.mjs campaign watch <id> --cwd <repo> --since <event-id>
node <skill-dir>/scripts/runner.mjs campaign sync <id> --cwd <repo> --session-id <session>
node <skill-dir>/scripts/runner.mjs campaign ack <id> --cwd <repo> --session-id <session> --event-id <event-id>
node <skill-dir>/scripts/runner.mjs campaign show <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign close <id> --cwd <repo>
```

`campaign start` launches the initial run from the pinned controller and
returns after the child readiness handshake. `campaign supervise --detach`
launches the campaign coordinator in its own process group; the launching CLI
may exit immediately. The coordinator continues until the campaign completes
or reaches attention, and can be restarted safely because its lease and action
ledger are durable.

For narrative handoff, use `campaign attach`, `campaign note`, and
`campaign resolve` as documented in the contract reference. Narrative handoff
state is separate from autonomy state: the run/node artifacts and campaign
control state remain authoritative for execution.
