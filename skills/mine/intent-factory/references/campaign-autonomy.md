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
The first matching row wins.

| Evidence | Action | Bound |
| --- | --- | --- |
| Every node is `done` or `no-op` | complete | Emit one completion event and close the campaign projection |
| Controller is dead and the run is nonterminal | resume | Consume one retry; stop at `retryLimit` |
| Timeout or stall | resume | Consume one retry; then `attention` |
| Provider exhaustion with an unused declared route | resume | Use one declared failover edge; no gate revision is consumed |
| Provider exhaustion without a route or after a cycle | attention | No implicit provider or account change |
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

## Notifications

Terminal campaign events are appended to
`notification-outbox.json` with a stable event ID, bounded summary/data,
attempt count, delivery timestamp, and last error. Duplicate event keys are
ignored; delivered entries are evicted first when the bounded outbox is full.

Set `INTENT_FACTORY_NOTIFY_BIN` to an executable that accepts one JSON event on
stdin and exits zero on successful delivery. `campaign drain` retries pending
events. At-least-once delivery is expected: a transport may receive an event
again after a process crash, so consumers should deduplicate by `eventId`.
The repository contains no relay credentials, recipient details, or private
transport implementation.

## Operational commands

All commands are public runner CLI operations and accept `--cwd <repo>`:

```bash
node <skill-dir>/scripts/runner.mjs campaign init <id> --cwd <repo> --goal "Goal"
node <skill-dir>/scripts/runner.mjs campaign configure <id> --cwd <repo> --contract <contract.json> --source-root <intent-factory-dir>
node <skill-dir>/scripts/runner.mjs campaign start <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign supervise <id> --cwd <repo> --detach --interval 30
node <skill-dir>/scripts/runner.mjs campaign status <id> --cwd <repo>
node <skill-dir>/scripts/runner.mjs campaign drain <id> --cwd <repo>
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
