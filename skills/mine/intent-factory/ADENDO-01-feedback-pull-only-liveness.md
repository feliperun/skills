---
title: "Addendum 01: pull-only session feedback and ambient liveness"
version: 0.1.0
status: ready
date: 2026-09-02
owner: Felipe Broering
amends: "Intent Factory: efficiency, resilience and autonomy tech spec (0.3.0-draft)"
supersedes_sections: ["B1.1 (partial)", "B1.3", "B1.4 (partial)", "10 (order 1)", "metric sessionOverheadTokens"]
adds_sections: ["B1.6", "B1.7", "ADR-0019", "ADR-0020"]
baseline: feliperun/skills @ ca5a93b
---

# Addendum 01: pull-only session feedback and ambient liveness

## 1. Purpose

The 0.3 plan measured session feedback as a per-event payload, but a chat
harness re-reads cumulative context on every turn. A wake costs a complete
turn, including the harness preamble and conversation history. Periodic
progress wakes therefore multiply the campaign budget without producing work.

The user needs progress information; the control session does not. The real
requirement is continuous liveness — whether work has progressed or been
stuck — rather than another discrete event in model context.

## 2. ADR-0019: the control session is pull-only

The factory never involves the control session for progress. Push goes to a
human channel, never to model context.

The only session wake is an event with `requiresUser: true`: a blocking
question, exhausted failover routes, or campaign completion. A healthy
campaign should produce two or three such events, not one wake per progress
transition. `campaign sync` remains user initiated; when the user asks, its
cost is legitimate.

`canWake` on the Claude adapter is reserved for `requiresUser: true` and is
not used for progress.

## 3. ADR-0020: deterministic ambient liveness

The harness renders continuous state from a derived local artifact without API
tokens. Claude Code's `statusLine` command receives session JSON on stdin,
runs locally, and may refresh on a timer through `refreshInterval`. This is
verified for Claude Code only; other harnesses enter B1.7 investigation.

## 4. Derived artifact: `heartbeat.json`

Path: `.runs/campaigns/<id>/heartbeat.json`.

The heartbeat is a bounded read cache, never the source of truth. Facts remain
append-only in `journal.jsonl`; the heartbeat is replaced atomically after a
successful fact write and can be rebuilt from that journal.

```json
{
  "schemaVersion": 1,
  "campaignId": "if-retro-20260902",
  "phase": "P2",
  "checkpoints": { "done": 3, "total": 7 },
  "activeNode": "P2.4-worktree-lifecycle",
  "runtime": "glm",
  "state": "running",
  "weightedUsed": 2340112,
  "weightedCap": 6000000,
  "lastProgressAt": 1756742400,
  "attention": null,
  "generatedAt": 1756742580
}
```

`state` is derived at write time and is one of `running`, `waiting_gate`,
`blocked`, `paused_quota`, `done`, or `failed`. `lastProgressAt` records the
last observed progress (scope-signature change or node transition), not the
last emitted event. `attention` is null on the happy path and otherwise is a
bounded string of at most 80 characters. The canonical JSON is at most 1 KiB;
the write is temp-plus-rename and readers never observe a partial file. A
failed fact write pins the heartbeat at its previous value.

## 5. Four channels and consumers

| Channel | Consumer | Token cost | When |
|---|---|---:|---|
| Claude Code `statusLine` | human at the keyboard | zero | continuously |
| OS notification | human near the machine | zero | discrete event |
| Ford (WhatsApp) | human away from the machine | zero | discrete event in a long campaign |
| control-session context | the session | 40k–80k before context diet | only `requiresUser: true` |

The detached supervisor owns the first three channels, so OS notification is
harness agnostic. Notify adapters expose:

```js
capabilities: {
  canPush: boolean,
  canWake: boolean,
  canRenderAmbient: boolean
}
```

`canRenderAmbient: true` is verified only for Claude Code in this addendum.

## 6. New campaign nodes

### B1.6 — heartbeat and ambient rendering

Write scope:

```text
skills/mine/intent-factory/scripts/heartbeat.mjs
skills/mine/intent-factory/scripts/notify/os-macos.mjs
skills/mine/intent-factory/scripts/notify/index.mjs
skills/mine/intent-factory/statusline/claude-code.sh
skills/mine/intent-factory/test/heartbeat.test.mjs
skills/mine/intent-factory/references/feedback.md
```

Non-goals: session wake, management UI, and adapters for harnesses other than
Claude Code and macOS.

Definition of Done:

| id | requirement | proof |
|---|---|---|
| d1 | heartbeat is atomic at node and phase transitions | `npm test -- --test-name-pattern="heartbeat atomic"` |
| d2 | heartbeat never exceeds 1 KiB | `npm test -- --test-name-pattern="heartbeat bounded"` |
| d3 | `lastProgressAt` comes from observed progress, not event emission | `npm test -- --test-name-pattern="heartbeat progress source"` |
| d4 | heartbeat rebuilds from `journal.jsonl` alone | `npm test -- --test-name-pattern="heartbeat rebuild"` |
| d5 | fact persistence failure leaves the heartbeat unchanged | `npm test -- --test-name-pattern="heartbeat pinned on failure"` |
| d6 | status line runs under 50 ms with a heartbeat | `bash statusline/bench.sh` |
| d7 | status line degrades silently without heartbeat and without `jq` | `npm test -- --test-name-pattern="statusline degrades"` |
| d8 | macOS notify handles `node.terminal`, `run.terminal` and attention | `npm test -- --test-name-pattern="notify macos"` |
| d9 | no adapter is invoked for progress events without `requiresUser` | `npm test -- --test-name-pattern="notify no progress push"` |
| d10 | feedback reference documents all four channels and their boundary | `skills/mine/intent-factory/references/feedback.md` |

The versioned status-line script reads only the JSON on stdin and the newest
1 KiB heartbeat. It invokes no `git` or external process. The optional Claude
Code configuration is:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/if-statusline.sh",
    "refreshInterval": 30
  }
}
```

`install-skill` offers this status-line script as an optional installation; it
does not alter the user's Claude Code settings unless explicitly requested.

### B1.7 — ambient rendering investigation by harness

Write scope:

```text
skills/mine/intent-factory/references/harness-feedback.md
```

This read-only research node writes one table row for each `claude`, `codex`,
`opencode`, `pi`, `agy` and `cursor` harness with mechanism, token cost, an
official documentation URL and verification date. Unverified mechanisms are
marked explicitly. A discovered mechanism becomes a later implementation node,
never code in B1.7.

## 7. `campaign sync` revision

The existing `campaign sync` remains user initiated and keeps its 2,000-token
output ceiling, adding one liveness line derived from `heartbeat.json`. The
factory never invokes it for progress.

## 8. Revised metrics and evals

Remove `sessionOverheadTokens`. Add:

| Metric | Definition | Target |
|---|---|---:|
| `sessionContextGrowth` | permanent tokens added to the control-session context during a campaign | below 4k |
| `sessionWakeCount` | times the factory involved the control session | below 3 per campaign |
| `heartbeatStaleness` p95 | heartbeat age when read | below 60 s |
| `ambientCoverage` | fraction of campaign time with a fresh heartbeat | above 0.95 |

`sessionWakeCount` is the governance metric. More than three wakes means the
autonomy boundary or campaign plan is defective.

Add deterministic evals:

| ID | Proves |
|---|---|
| D27 | a complete campaign with no `requiresUser` event has wake count 0 |
| D28 | a node stuck for 40 minutes shows an aged `lastProgressAt` without emitting an event |
| D29 | a rebuilt heartbeat is byte-identical to the recorded heartbeat |
| D30 | a crash between fact and heartbeat writes leaves the old heartbeat intact |

The pre-existing release-1 D27 network-backoff and D28 inbox cases are
renumbered D31 and D32 in the amended master spec to avoid duplicate IDs.

## 9. Revised sequencing

Replace the previous order-1 session-feedback item with:

| Order | Item | Runtime token cost | Reason |
|---|---|---:|---|
| 1a | B1.6 heartbeat, status line and OS notification | zero | solves liveness without harness wake |
| 1b | B1.7 harness investigation | low, once | removes uncertainty without speculative code |
| 1c | Ford campaign-long adapter | zero at runtime | reuses the existing sidecar |
| 1d | revised `campaign sync` | pull only | user-requested cost |
| after B4.4 | session wake for `requiresUser: true` | about 12k after context diet | only rare actionable involvement |

The session wake is not implemented before B4.4. With a 19k-token preamble,
every wake is expensive; with the 24 KiB preamble ceiling it becomes acceptable
for rare actionable events.

## 10. Removals and load-bearing rule

Remove the progress-wake implication from B1.1, remove B1.3 coalescing and
interruption budget as a session-wake policy, remove `sessionOverheadTokens`,
and replace the old order-1 item. Add load-bearing rule 13:

> Never wake the control session for progress. Progress is for humans through
> ambient rendering or system notification; the session is involved only when
> it must act.

The risks are bounded by OS/Ford fallback, the 50 ms status-line proof,
heartbeat rebuild and pinning tests, and `requiresUser` bypassing all progress
coalescing. The addendum applies only to this plan and does not broaden
production or credential authority.
