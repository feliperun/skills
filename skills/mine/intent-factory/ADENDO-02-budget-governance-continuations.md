---
title: "Addendum 02: systemic budget governance and deterministic continuations"
version: 0.2.0
status: ready
date: 2026-09-02
owner: Felipe Broering
amends: "Intent Factory: efficiency, resilience and autonomy tech spec (0.6.0)"
supersedes_sections: ["5.2 derived per-node budget", "10.3 ledger and budgets", "10.4 phase order"]
adds_sections: ["B4.5", "B4.6", "ADR-0021", "ADR-0022"]
baseline: feliperun/skills @ 9c6dffc
---

# Addendum 02: systemic budget governance and deterministic continuations

## 1. Incident and objective

The phase-0 contract placed `maxInputTokens: 500000` on the first DeepSeek
node. That number was authored in the contract; it is not a runner constant or
a provider limit. The runner correctly enforced it as a cumulative weighted
node budget, but the plan supplied no derivation, no reservation for the
remaining graph and no continuation when the node made valid progress.

The node consumed 573,336.4 weighted tokens, became blocked, and its dependent
nodes remained blocked. The campaign then had no deterministic budget
continuation and no ambient liveness implementation, so the failure could sit
unnoticed for hours. This addendum makes budget governance a system property:
every budget decision is derived, persisted, observable and recoverable.

## 2. Terminology and boundaries

These quantities are never interchangeable:

| Quantity | Meaning | Governing mechanism |
|---|---|---|
| context window | tokens present in one provider request | runtime capability/preflight |
| weighted node budget | cumulative input spend for one node across turns | deterministic budget policy |
| phase reserve | spend held for pending nodes and judges | ledger policy |
| wall-clock deadline | elapsed execution bound | invocation timeout |

The context window is not a cumulative node budget. A 1M-token context window
does not justify a handwritten 1M cumulative cap, and a 500k cumulative cap is
not a context-safety limit.

## 3. ADR-0021: budget decisions are derived and attributable

No contract may contain an unexplained per-node token number. Each executable
node carries a `budgetProfile` with the measured or declared inputs used by the
policy:

```json
{
  "estimatedWeightedInputTokens": 420000,
  "estimatedTurns": 12,
  "contextWindowTokens": 1000000,
  "safetyFraction": 0.75,
  "minimumSegmentTokens": 100000,
  "growthIncrementTokens": 100000,
  "preambleBytes": 24000,
  "tokenizerEstimate": {
    "bytes": 77404,
    "tokens": 19000,
    "source": "measured skill preamble"
  },
  "continuation": {
    "enabled": true,
    "maxSegments": 2,
    "segmentReserveTokens": 300000
  }
}
```

Policy version `budget-v1` derives the allocation with no model judgment or
magic per-node constant. Let `packetTokens` and `preambleTokens` be the
measured UTF-8 byte counts converted with the configured tokenizer estimate;
then:

```text
requestHeadroom = floor((contextWindowTokens - packetTokens - preambleTokens)
                        * safetyFraction)
contextAllowance = requestHeadroom * estimatedTurns
available = min(phaseRemaining, campaignRemaining - judgeReserve)
pendingReserve = sum(pendingNode.minimumSegmentTokens)
continuationReserve = continuation.enabled
  ? continuation.segmentReserveTokens : 0
initial = min(estimatedWeightedInputTokens, contextAllowance,
              available - pendingReserve - continuationReserve)
```

The controller rejects an allocation below `minimumSegmentTokens` unless the
node is already complete, and records every operand, rounding step and reject
reason in `budgetDecision`. An extension is exactly
`min(growthIncrementTokens, unusedAvailableAfterReserves)` and is granted only
after an observed progress signature changes. These formulas and profile
fields are versioned policy, so a replay cannot silently reinterpret a budget.

The controller computes and persists a `budgetDecision` before dispatch. A
profile without attributable context-window, preamble and tokenizer inputs is
invalid; a bare declared capacity is not sufficient provenance. The decision
includes the policy version, packet bytes, measured preamble, runtime context
capacity, phase and campaign remaining allowance, pending-node minimum
reserves, the estimate, and the resulting initial and hard caps. Replaying the
same facts produces byte-identical JSON. A handwritten `maxInputTokens` may
only be an explicit hard ceiling above the derived initial allocation; it is
never the allocation itself.

The policy reserves the minimum declared continuation and pending-node budget
before granting extra headroom. It may grant unused phase allowance in fixed,
recorded increments, but never consumes the reserve for another pending node or
the judge. If the inputs cannot produce a safe allocation, the node enters an
observable budget decision state and the supervisor emits attention; it never
silently waits.

## 4. ADR-0022: continuation is predeclared, not improvised

When a node approaches its derived allocation with observed progress, the
controller requests a soft boundary. Only after the current segment reaches a
settled, verified checkpoint does it write the deterministic capsule and
activate the next
predeclared segment. The continuation reuses the exact task packet, write scope,
verification and runtime identity unless the contract explicitly declares an
allowed failover. It is idempotent, has a bounded segment count, and cannot
invent a new node, file or instruction at runtime.

Budget exhaustion therefore has three deterministic outcomes:

1. continue through a predeclared segment while reserved allowance exists;
2. use a declared provider failover only when the provider reported exhaustion;
3. otherwise settle as `attention` with a heartbeat, notification and bounded
   finding.

The controller never converts a budget stop into an implicit provider switch,
dynamic task split or replan. This narrows rule 9 without weakening the
planning boundary: continuation topology is frozen at authoring time.

A hard-cap kill is never a safe checkpoint. If the worker crosses the hard cap
before settling the soft boundary, the node enters `attention` with ambiguous
effects and cannot continue automatically.

## 5. B4.5 — systemic budget controller

**Write scope**

```text
skills/mine/intent-factory/scripts/budget.mjs
skills/mine/intent-factory/scripts/contract.mjs
skills/mine/intent-factory/scripts/runner.mjs
skills/mine/intent-factory/scripts/campaign-autonomy.mjs
skills/mine/intent-factory/test/budget.test.mjs
skills/mine/intent-factory/references/budget-governance.md
```

**Non-goals**

- Do not raise every node to 1M by default.
- Do not use an LLM to choose or extend a budget.
- Do not create an unplanned node or broaden a write scope at runtime.
- Do not wake the control session for progress; Addendum 01 remains in force.

**Definition of Done**

| id | requirement | proof |
|---|---|---|
| d1 | no per-node cap is accepted without a reproducible `budgetProfile` and `budgetDecision` | `node --test --test-name-pattern='budget provenance' skills/mine/intent-factory/test/budget.test.mjs skills/mine/intent-factory/test/contract.test.mjs` |
| d2 | initial allocation reserves all pending nodes and judge allowance | `node --test --test-name-pattern='budget reserve' skills/mine/intent-factory/test/budget.test.mjs` |
| d3 | the same inputs produce byte-identical budget decisions | `node --test --test-name-pattern='budget deterministic' skills/mine/intent-factory/test/budget.test.mjs` |
| d4 | a healthy node receives bounded extension from unused allowance, never from another node's reserve | `node --test --test-name-pattern='budget extension' skills/mine/intent-factory/test/budget.test.mjs` |
| d5 | a budget boundary checkpoints and activates one predeclared continuation exactly once | `node --test --test-name-pattern='budget continuation' skills/mine/intent-factory/test/budget.test.mjs skills/mine/intent-factory/scripts/runner.test.mjs` |
| d6 | a continuation preserves packet hash, write scope and verification | `node --test --test-name-pattern='continuation scope' skills/mine/intent-factory/test/budget.test.mjs skills/mine/intent-factory/scripts/runner.test.mjs` |
| d7 | no authorized continuation settles as observable attention, never silent blocked | `node --test --test-name-pattern='budget attention' skills/mine/intent-factory/test/budget.test.mjs` |
| d8 | every budget block/extension/continuation updates heartbeat and human notification within one supervisor interval | `node --test --test-name-pattern='budget liveness' skills/mine/intent-factory/test/heartbeat.test.mjs skills/mine/intent-factory/test/campaign-autonomy.test.mjs` |
| d9 | a provider quota failure may fail over, while a local budget stop never implicitly changes provider | `node --test --test-name-pattern='budget failover boundary' skills/mine/intent-factory/test/budget.test.mjs skills/mine/intent-factory/scripts/runner.test.mjs` |
| d10 | a 1M-context runtime does not imply a 1M cumulative node allocation | `node --test --test-name-pattern='context budget distinction' skills/mine/intent-factory/test/budget.test.mjs` |

## 6. B4.6 — campaign watchdog and governance metrics

**Write scope**

```text
skills/mine/intent-factory/scripts/heartbeat.mjs
skills/mine/intent-factory/scripts/notify/index.mjs
skills/mine/intent-factory/scripts/notify/os-macos.mjs
skills/mine/intent-factory/scripts/campaign.mjs
skills/mine/intent-factory/scripts/campaign-autonomy.mjs
skills/mine/intent-factory/scripts/campaign-cli.mjs
skills/mine/intent-factory/scripts/runner.mjs
skills/mine/intent-factory/test/heartbeat.test.mjs
skills/mine/intent-factory/test/campaign-autonomy.test.mjs
skills/mine/intent-factory/scripts/runner.test.mjs
skills/mine/intent-factory/references/campaign-autonomy.md
```

The supervisor records `budgetDecisionAge`, `budgetHeadroomAtDispatch`,
`budgetExtensionRate`, `continuationRate`, `budgetAttentionLatencyP95` and
`silentStallRate`. `silentStallRate` has a hard target of zero. A nonterminal
run without an observed heartbeat transition within the configured liveness
interval produces a human-channel attention event and a fresh heartbeat; it
never remains invisible until a user happens to run `sync`.

The derived metrics are written atomically to
`.runs/campaigns/<id>/governance-metrics.json`. Budget decisions and state
transitions provide their timestamps; metrics never infer them from log prose.
This node pulls forward the heartbeat core and the macOS human notification
adapter from B1.6 because observability is a prerequisite for budget safety.

**Definition of Done**

| id | requirement | proof |
|---|---|---|
| d1 | budget stop is visible in heartbeat and reaches a human channel within one supervisor interval | `node --test --test-name-pattern='budget liveness' skills/mine/intent-factory/test/heartbeat.test.mjs skills/mine/intent-factory/test/campaign-autonomy.test.mjs` |
| d2 | a stale nonterminal run emits one deduplicated attention event and keeps a fresh heartbeat | `node --test --test-name-pattern='watchdog stale liveness' skills/mine/intent-factory/test/heartbeat.test.mjs skills/mine/intent-factory/test/campaign-autonomy.test.mjs` |
| d3 | progress events never push to the human or session channels | `node --test --test-name-pattern='notify no progress push' skills/mine/intent-factory/test/heartbeat.test.mjs` |
| d4 | the watchdog works for a legacy campaign without `plan.json` | `node --test --test-name-pattern='campaign liveness planless' skills/mine/intent-factory/test/campaign-autonomy.test.mjs` |
| d5 | governance metrics are reproducible and `silentStallRate` is zero in D36/D38 | `node --test --test-name-pattern='governance metrics' skills/mine/intent-factory/test/heartbeat.test.mjs` |

## 7. New deterministic evals

| ID | Proves |
|---|---|
| D33 | a node with a 1M context capability receives a derived allocation with the recorded safety margin, not an arbitrary 500k or 1M literal |
| D34 | pending-node and judge reserves remain intact while a progressing node receives an extension |
| D35 | a budget boundary creates exactly one continuation capsule and no duplicate side effect |
| D36 | continuation exhaustion emits heartbeat, human notification and `attention` within one supervisor interval |
| D37 | budget stop never performs implicit provider failover or runtime task splitting |
| D38 | a nonterminal run stalled for 40 minutes is visible as stale liveness, never a silent active state |
| D39 | replaying the budget decision from journal facts is byte-identical |

## 8. Sequencing

This addendum is a gate before the next campaign phase:

| Order | Item | Rule |
|---|---|---|
| 0a | freeze the failed run and checksum its evidence | the old run can be read but never resumed |
| 0b | B4.5 budget policy, provenance and durable decision | final bootstrap under the legacy controller |
| 0c | refresh the immutable controller snapshot | all later contracts require `budgetProfile` |
| 0d | pull forward B1.6 heartbeat core and one human channel | removes the circular liveness dependency |
| 0e | B4.5 runner integration and settled continuations | reserve before dispatch; hard kills never continue |
| 0f | B4.6 watchdog, metrics and D33–D39 gate | required before campaign work resumes |
| 1 | create a new pruned run for unfinished phase-0 nodes | never resume the frozen run or redo completed objectives |
| 2 | finish Addendum 01 B1.6/B1.7 ambient feedback | status line and harness research remain here |

The existing 500k phase-0 cap is not silently increased in place. The failed
run is frozen with a checksum manifest. A new pruned contract carries the
derivation, reserved allowance and fallback policy for only the unfinished
objectives.

## 9. Load-bearing rules

Add to the master rules:

16. **Never authorize a budget without provenance.** Every allocation and
    extension records the measured inputs and policy version that produced it.
17. **Never leave a budget state unobservable.** A block, extension,
    continuation or watchdog timeout writes heartbeat and human-channel
    evidence within one supervisor interval.
18. **Never improvise a continuation.** Runtime continuation may only activate
    topology, scope and reserves declared in the frozen contract.

This is a systemic correction, not a larger heuristic. It makes the failure
class testable, bounded and visible before a campaign can sit unattended.
