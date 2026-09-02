---
title: "Addendum 02: systemic budget governance and deterministic continuations"
version: 0.1.0
status: ready
date: 2026-09-02
owner: Felipe Broering
amends: "Intent Factory: efficiency, resilience and autonomy tech spec (0.6.0)"
supersedes_sections: ["5.2 derived per-node budget", "10.3 ledger and budgets", "10.4 phase order"]
adds_sections: ["B4.5", "B4.6", "ADR-0021", "ADR-0022"]
baseline: feliperun/skills @ a70bdd8
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
  "continuation": {
    "enabled": true,
    "maxSegments": 2,
    "segmentReserveTokens": 300000
  }
}
```

The controller computes and persists a `budgetDecision` before dispatch. It
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
controller checkpoints the deterministic capsule and activates the next
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
| d1 | no per-node cap is accepted without a reproducible `budgetProfile` and `budgetDecision` | `npm test -- --test-name-pattern="budget provenance"` |
| d2 | initial allocation reserves all pending nodes and judge allowance | `npm test -- --test-name-pattern="budget reserve"` |
| d3 | the same inputs produce byte-identical budget decisions | `npm test -- --test-name-pattern="budget deterministic"` |
| d4 | a healthy node receives bounded extension from unused allowance, never from another node's reserve | `npm test -- --test-name-pattern="budget extension"` |
| d5 | a budget boundary checkpoints and activates one predeclared continuation exactly once | `npm test -- --test-name-pattern="budget continuation"` |
| d6 | a continuation preserves packet hash, write scope and verification | `npm test -- --test-name-pattern="continuation scope"` |
| d7 | no authorized continuation settles as observable attention, never silent blocked | `npm test -- --test-name-pattern="budget attention"` |
| d8 | every budget block/extension/continuation updates heartbeat and human notification within one supervisor interval | `npm test -- --test-name-pattern="budget liveness"` |
| d9 | a provider quota failure may fail over, while a local budget stop never implicitly changes provider | `npm test -- --test-name-pattern="budget failover boundary"` |
| d10 | a 1M-context runtime does not imply a 1M cumulative node allocation | `npm test -- --test-name-pattern="context budget distinction"` |

## 6. B4.6 — campaign watchdog and governance metrics

The supervisor records `budgetDecisionAge`, `budgetHeadroomAtDispatch`,
`budgetExtensionRate`, `continuationRate`, `budgetAttentionLatencyP95` and
`silentStallRate`. `silentStallRate` has a hard target of zero. A nonterminal
run without an observed heartbeat transition within the configured liveness
interval produces a human-channel attention event and a fresh heartbeat; it
never remains invisible until a user happens to run `sync`.

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
| 0a | repair the blocked phase-0 continuation using a derived budget decision | no handwritten 500k cap |
| 0b | B4.5 systemic budget controller | required before new work |
| 0c | B4.6 watchdog and governance metrics | required before phase completion |
| 1 | Addendum 01 B1.6/B1.7 ambient feedback | only after 0a–0c are green |

The existing 500k phase-0 cap is not silently increased in place. The
continuation contract must carry its derivation, reserved allowance and
fallback policy, and the old blocked run remains immutable evidence.

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
