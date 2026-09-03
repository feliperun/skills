# Budget governance reference

Budget governance is the deterministic policy behind Addendum 02
(`ADENDO-02-budget-governance-continuations.md`), documented from the
implementation, never the reverse: every field, formula, schema and status
below matches `scripts/budget.mjs` and `scripts/heartbeat.mjs` today
(policy `budget-v1`).

## Terminology

The four quantities from Addendum 02 section 2 are never interchangeable:

| Quantity | Meaning | Governing mechanism |
| --- | --- | --- |
| context window | tokens present in one provider request | runtime capability/preflight |
| weighted node budget | cumulative input spend for one node across turns | deterministic budget policy (`budget-v1`) |
| phase reserve | spend held for pending nodes and judges | ledger policy |
| wall-clock deadline | elapsed execution bound | invocation timeout |

A 1M context window is not a cumulative node budget and a cumulative cap is
not a context-safety limit (profile example: Addendum 02 section 3).

## budgetProfile

`validateBudgetProfile` accepts exactly these fields; unknown or missing keys
throw a `TypeError` and the normalized profile is returned:

| Field | Type and constraint |
| --- | --- |
| `estimatedWeightedInputTokens` | positive safe integer; expected cumulative weighted input, an operand of the initial min |
| `estimatedTurns` | positive safe integer; expected provider turns |
| `contextWindowTokens` | positive safe integer; one-request runtime capability |
| `safetyFraction` | positive finite number, must not exceed 1; reserved fraction of per-request headroom |
| `minimumSegmentTokens` | positive safe integer; floor below which allocation/segments are refused |
| `growthIncrementTokens` | positive safe integer; the fixed extension increment |
| `preambleBytes` | non-negative safe integer; measured harness preamble bytes |
| `tokenizerEstimate` | object `{bytes, tokens, source}`; `bytes`/`tokens` positive integers, `source` non-empty string <= 512 UTF-8 bytes |
| `continuation` | object `{enabled, maxSegments, segmentReserveTokens}`; see below |

`continuation.enabled` is boolean, `maxSegments` a positive integer and
`segmentReserveTokens` a non-negative integer. The disabled shape is exact:
`enabled: false` requires `maxSegments: 1` and `segmentReserveTokens: 0`.
When enabled, `maxSegments` must be at least 2 and `segmentReserveTokens` at
least `minimumSegmentTokens * (maxSegments - 1)` so the reserve funds every
minimum segment.

## Policy budget-v1

`deriveBudgetDecision` first converts bytes with the estimate
`estimatedTokens(bytes) = ceil(bytes * est.tokens / est.bytes)`:
`packetTokens` from `packetBytes`, `preambleTokens` from `preambleBytes`. All
intermediates clamp to zero; `*` is the safe-integer product:

```text
requestHeadroomTokens = max(0, floor((contextWindowTokens - packetTokens - preambleTokens) * safetyFraction))
contextAllowanceTokens = requestHeadroomTokens * estimatedTurns
availableTokens = max(0, min(phaseRemainingTokens, max(0, campaignRemainingTokens - judgeReserveTokens)))
continuationReserveTokens = continuation.enabled ? segmentReserveTokens : 0
initialAllocationTokens = max(0, min(estimatedWeightedInputTokens, contextAllowanceTokens,
                            availableTokens - pendingReserveTokens - continuationReserveTokens))
derivedHardCapTokens = max(0, min(contextAllowanceTokens, availableTokens - pendingReserveTokens))
hardCapTokens = min(derivedHardCapTokens, explicitHardCeilingTokens ?? derivedHardCapTokens)
```

`facts.explicitHardCeilingTokens` is `null` when absent: a handwritten
`maxInputTokens`-style ceiling can only shrink the derived hard cap, never
enlarge it, and is never the allocation itself. The decision is rejected with
the recorded `rejectReason` when either guard fires:

1. `initialAllocationTokens < minimumSegmentTokens` → `derived allocation N
   is below minimum segment M`.
2. `hardCapTokens < initialAllocationTokens + continuationReserveTokens` →
   `explicit hard ceiling cannot preserve the declared continuation reserve`.

A healthy decision reports `extensionAllowanceTokens = max(0, hardCapTokens -
initialAllocationTokens - continuationReserveTokens)`: headroom exists only
after pending and continuation reserves, and the hard cap never includes the
continuation reserve.

## budgetDecision schema

Persisted before dispatch and replayed byte-identically
(`canonicalBudgetDecision` sorts keys). Top level (`DECISION_FIELDS`):
`policyVersion` (`"budget-v1"`), `packetHash`, `scopeHash`, `verificationHash`
(SHA-256 hex), `inputs`, then non-negative integers `requestHeadroomTokens`,
`contextAllowanceTokens`, `availableTokens`, `pendingReserveTokens`,
`judgeReserveTokens`, `continuationReserveTokens`, `initialAllocationTokens`,
`extensionAllowanceTokens`, `hardCapTokens`; positive integers `maxSegments`,
`growthIncrementTokens`, `minimumSegmentTokens`; `status`
(`"allocated"`/`"rejected"`); `rejectReason` (`null` or non-empty string <=
1024 bytes, present exactly when rejected).

`inputs` (`DECISION_INPUT_FIELDS`): `runtimeId` (<= 128 bytes), non-negative
integers `packetBytes`, `packetTokens`, `preambleBytes`, `preambleTokens`,
`contextWindowTokens`, `estimatedTurns`, `estimatedWeightedInputTokens`,
`phaseRemainingTokens`, `campaignRemainingTokens`, `judgeReserveTokens`,
`pendingReserveTokens`; positive number `safetyFraction`;
`tokenizerEstimate` `{bytes, tokens, source}`; `explicitHardCeilingTokens`
(`null` or positive integer).

## budgetState schema and status values

`validateBudgetState` accepts exactly (`STATE_FIELDS`): non-negative integers
`currentCapTokens`, `extensionRemainingTokens`, `continuationRemainingTokens`;
positive integer `segment`; non-empty positive-integer array
`activatedSegments`; `pendingSegment` (`null` or
`{id, segment, allocationTokens, packetHash, scopeHash, verificationHash}`
with hashes SHA-256); `lastGrantedProgressSignature` (`null` or non-empty
string <= 256 bytes); `status` one of `"active"`, `"continuing"`,
`"attention"`, `"complete"`.

`initialBudgetState` seeds `currentCapTokens = initialAllocationTokens`,
`extensionRemainingTokens = extensionAllowanceTokens`,
`continuationRemainingTokens = continuationReserveTokens`, `segment: 1`,
`activatedSegments: [1]`, `pendingSegment: null`,
`lastGrantedProgressSignature: null`, `status: "active"` (allocated) or
`"attention"` (rejected).

## Extensions

`grantBudgetExtension(decision, state, progressSignature)` returns the state
plus `grantedTokens`. It grants 0 — no mutation — when the signature is
missing, equals `lastGrantedProgressSignature`, or
`extensionRemainingTokens` is 0. Otherwise `grantedTokens = min(
growthIncrementTokens, extensionRemainingTokens)`, `currentCapTokens`
increases and `extensionRemainingTokens` decreases by it, and the signature
becomes `lastGrantedProgressSignature`. Increments are the decision's fixed
`growthIncrementTokens` steps; an extension never touches
`continuationRemainingTokens`, pending-node reserves or the judge reserve.

## Continuations

`planBudgetContinuation(decision, state)` is idempotent: while
`pendingSegment` is set it returns that same object, so activation happens
exactly once. It returns `null` when `continuationRemainingTokens` is 0 or
`segment >= maxSegments`. Otherwise it splits the reserve:
`allocationTokens = floor(continuationRemainingTokens / (maxSegments -
segment))`, `null` when below `minimumSegmentTokens`. The segment is
`{id: "<packetHash>:<segment+1>", segment: segment + 1, allocationTokens,
packetHash, scopeHash, verificationHash}`: the id format is
`packetHash:segmentNumber` and the three identity hashes are copied from the
decision, preserving packet, write scope and verification identity. Segment
count and reserve are bounded by the frozen profile; a continuation never
invents a node, file or instruction at runtime. A hard-cap kill is never a
checkpoint: crossing the hard cap before the soft boundary settles is
ambiguous-effect `attention` and cannot continue automatically (Addendum 02
section 4, enforced by the supervisor outside `budget.mjs`).

## Attention and liveness

- `budget_attention` — a `budgetAction` of type `attention` surfaces as a
  `run.attention` outbox event with `data.code: "budget_attention"`;
  `heartbeat.mjs` pairs the first such event per node with its `budgetAction`
  attention event to measure latency.
- Heartbeat — `heartbeat.json` is a derived key-sorted cache (<= 1024 bytes,
  `schemaVersion: 1`) rebuilt from the newest `liveness` journal fact. Fields:
  `schemaVersion`, `campaignId`, `phase`, `checkpoints {done, total}`,
  `activeNode`, `runtime`, `state`, `weightedUsed`, `weightedCap`,
  `lastProgressAt` (unix seconds), `attention` (<= 80 chars), `generatedAt`
  (unix seconds). States: `running`, `waiting_gate`, `blocked`,
  `paused_quota`, `done`, `failed`.
- Human channel — `run.attention` events are drained through
  `INTENT_FACTORY_NOTIFY_BIN` or the bundled macOS adapter; progress is never
  pushed to the human or session channels ([campaign-autonomy.md](campaign-autonomy.md)).
- Watchdog — each supervised nonterminal run is checked once per supervisor
  interval. A run is stale when none of its heartbeat progress, heartbeat
  generation or newest node snapshot is newer than the threshold (default 40
  minutes / 2400 s, override `INTENT_FACTORY_LIVENESS_SEC`). One
  `run.attention` with `data.code: "stale_liveness"` is emitted with dedupe
  key `<runId>:stale_liveness:<lastObservedAt ISO>` and a `blocked` liveness
  fact is recorded, so the stall is visible within one supervisor interval and
  never a silent active state. The watchdog reads only node snapshots and the
  campaign journal/outbox/heartbeat and works without `plan.json` or
  `control-state.json`.
- `stale_liveness` — with `budget_attention`, a covering attention code: a
  liveness gap carrying either between its endpoints is observed, not silent.
- One supervisor interval — a budget block, extension, continuation or
  watchdog timeout updates heartbeat and human evidence within one supervisor
  interval; `silentStallRate` has a hard target of zero.

## Governance metrics

`deriveGovernanceMetrics` (`heartbeat.mjs`) writes
`governance-metrics.json` atomically to `.runs/campaigns/<id>/`. Derivation is
pure over events, liveness facts and outbox entries; rates and percentiles
round to 4 decimals.

| Field | Meaning |
| --- | --- |
| `budgetDecisionAge` | seconds since the newest `budgetDecision` event of a nonterminal node; `null` when none |
| `budgetHeadroomAtDispatch` | mean `extensionAllowanceTokens` over decision events; `null` when none |
| `budgetExtensionRate` | `extension` actions / decisions, capped at 1; `null` when no decisions |
| `continuationRate` | `continuation_activated` actions / decisions, capped at 1; `null` when no decisions |
| `budgetAttentionLatencyP95` | 95th percentile, seconds, of first outbox `budget_attention` per node minus its `budgetAction` attention event; `null` when none |
| `silentStallRate` | fraction of consecutive nonterminal liveness facts whose gap exceeded `staleSec` (default `GOVERNANCE_STALE_SEC = 2400`) with no covering `stale_liveness`/`budget_attention` event; 0 without qualifying gaps; hard target zero |

Terminal statuses (`done`, `no-op`, `blocked`, `failed`, `exhausted`,
`stalled`, `canceled`, `cancelled`) end a node's age contribution and a
liveness measurement sequence.

## Evals D33-D39

- D33 — derived non-literal 1M-context allocation: `budget deterministic D33` in `test/budget.test.mjs`
- D34 — reserves intact while a progressing node is extended: `budget extension D34` in `test/budget.test.mjs`
- D35 — one bounded deterministic continuation: `budget continuation D35` in `test/budget.test.mjs`
- D36 — below-floor allocation rejects observably: `budget attention D36` in `test/budget.test.mjs`
- D37 — no implicit provider failover or task split: `budget failover boundary D37` in `test/budget.test.mjs`
- D38 — stalled run visible as stale liveness: `watchdog stale liveness` in `test/campaign-autonomy.test.mjs`, indexed by `watchdog D38 reference` in `test/budget.test.mjs`
- D39 — byte-identical replay from journal facts: `budget replay D39` in `test/budget.test.mjs`
