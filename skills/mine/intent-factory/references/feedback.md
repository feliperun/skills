# Campaign feedback: channels, heartbeat and notify transport

This reference specifies how intent-factory surfaces campaign feedback to
humans and why the control session stays out of the progress loop. It is the
companion to Addendum 01 (ADR-0019 and ADR-0020), the campaign autonomy
reference, and `references/contract.md`.

## Boundary: the control session is pull-only

Campaign feedback is human-channel feedback. The control session is never
involved for progress.

- ADR-0019 — the factory wakes the control session only for an event with
  `requiresUser: true`: a blocking question, exhausted failover routes, or
  campaign completion. `campaign sync` remains user initiated; `canWake` on
  the Claude adapter is reserved for `requiresUser: true` and is never used
  for progress.
- ADR-0020 — continuous liveness is rendered from a derived local artifact
  (`heartbeat.json`) without API tokens. Claude Code's `statusLine` command
  reads it locally on a timer; the human at the keyboard sees campaign
  liveness at zero token cost.
- Load-bearing rule — never wake the control session for progress. Progress
  is for humans through ambient rendering or system notification; the
  session is involved only when it must act.
- Healthy campaigns therefore produce two or three session wakes, not one
  wake per progress transition.

## Channels

| Channel | Consumer | Token cost | When |
| --- | --- | ---: | --- |
| Claude Code `statusLine` | human at the keyboard | zero | continuously |
| OS notification | human near the machine | zero | discrete event |
| Ford (WhatsApp) | human away from the machine | zero | discrete event in a long campaign |
| control-session context | the session | 40k–80k before the context diet | only `requiresUser: true` |

The detached supervisor owns the first three channels, so OS notification is
harness agnostic. Notify adapters expose `canPush`, `canWake`, and
`canRenderAmbient` capabilities; `canRenderAmbient: true` is verified for
Claude Code only in Addendum 01. Progress events (`campaign.progress`) and
any type outside the push set are never routed to any adapter or session.

## Heartbeat artifact

Path: `.runs/campaigns/<id>/heartbeat.json`.

The heartbeat is a bounded read cache, never the source of truth. Facts stay
append-only in `journal.jsonl`; the heartbeat is derived from the newest
liveness fact, rewritten atomically (temp-plus-rename) after a successful
fact write, and can be rebuilt from the journal alone. A failed fact write
pins the heartbeat at its previous value.

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

`state` is one of `running`, `waiting_gate`, `blocked`, `paused_quota`,
`done`, or `failed`. `lastProgressAt` records the last observed progress
(scope-signature change or node transition), not the last emitted event.
`attention` is null on the happy path and otherwise a bounded string of at
most 80 characters. The canonical JSON is at most 1 KiB, key-sorted and
compact. `readHeartbeat` tolerates a missing, stale, or oversized file;
`rebuildHeartbeat` reproduces the recorded file byte-identically from
`journal.jsonl` alone.

## Exec transport contract (`INTENT_FACTORY_NOTIFY_BIN`)

`campaign drain` delivers outbox events through the executable named by
`INTENT_FACTORY_NOTIFY_BIN`. The contract:

- One JSON event object on stdin. The event carries a stable `eventId`,
  `type`, bounded `summary`/`data`, and delivery metadata.
- Exit code 0 confirms delivery. An adapter exits 0 only after the event is
  durably accepted by the destination channel; any other exit code or signal
  leaves the event undelivered.
- Delivery is at-least-once. A transport may receive the same event again
  after a process crash or retry, so consumers deduplicate by `eventId`.
  Duplicate outbox keys are ignored by the drain.
- Queueing adapters never confirm on failure: when a queue write fails, the
  adapter reports failure instead of exiting 0, and `campaign drain` keeps
  retrying the pending event.
- Private implementations stay outside the repository. Recipients,
  credentials, and transport details of a private adapter (for example a
  personal WhatsApp relay) are never committed; only this contract is
  documented, and the repository contains no relay credentials or recipient
  details.
- When `INTENT_FACTORY_NOTIFY_BIN` is unset, `drain` falls back to the
  bundled platform adapters (the macOS `osascript` adapter on darwin, none
  elsewhere). Neither path ever pushes `campaign.progress`.

## Status line installation

The optional Claude Code status line renders `heartbeat.json` continuously.
`statusline/claude-code.sh` ships with the skill, so the `skills` installer
copies it along with everything else; wiring it in stays an explicit user
action, and nothing here ever edits a user's Claude Code settings. When the
user enables it, `settings.json` carries:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/if-statusline.sh",
    "refreshInterval": 30
  }
}
```

The command receives the Claude Code session JSON on stdin and reads only
that JSON plus the newest 1 KiB heartbeat under the repository's
`.runs/campaigns/`. It invokes no git and no network. It prints one line of
at most 160 characters:

```text
if <campaignId> <state> <done>/<total> <activeNode> <runtime> <usedK>k/<capK>k <age>m ago[ · attention: <text>]
```

Its process budget is shell builtins, plus `jq` when it exists, plus exactly
one other external process: the bounded read (`head -c 1025`). That probe is
both the read cap and the size check, so no tool ever receives the whole
file and a heartbeat over the 1 KiB cap is rejected before a parser sees it.
Where `head` is absent, the shell reads the bounded line itself and applies
the same cap. Without `jq`, fields come from a POSIX builtin JSON reader that
consumes strings escape-aware, so an `attention` value carrying quotes or an
escaped field name is rendered verbatim and can never forge another field.
With `jq` the age is minutes since `lastProgressAt` measured against the
current time; without it POSIX `sh` has no clock builtin, so the age is
measured against `generatedAt` — the moment the cache was written — and a
heartbeat that stopped being refreshed therefore shows the age it had at its
last write.

Degradation is silent by design:

- No heartbeat, an unreadable file, a file over the 1 KiB cap (including one
  whose first bytes are complete JSON), or a heartbeat the reader cannot
  parse safely prints an empty line and exits 0. The status line simply
  shows nothing; there is no error, no session wake, and no token cost.
- The median render time is under 50 ms (`statusline/bench.sh`), so the
  refresh timer stays cheap.

## Definition of Done mapping

- d6 — `bash skills/mine/intent-factory/statusline/bench.sh` proves the
  status line runs under 50 ms with a heartbeat.
- d7 — `statusline.test.mjs` proves silent degradation without a heartbeat,
  without `jq`, and on an oversized heartbeat, plus a render with no external
  tool on `PATH`.
- d10 — this reference documents all four channels and their boundary.
