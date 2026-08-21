---
name: session-memory
description: Save a curated summary of the current session before the usage limit hits and resume from it in a fresh session, instead of paying full price to re-read a long conversation without cache. Use when the user asks to save, snapshot, or hand off the session, when usage is running out, or at the start of a session that has a pending handoff file.
---

# Session Memory

A long session that survives a usage-limit reset is expensive twice: the
continuation re-reads the whole conversation without prompt cache. Instead,
save a curated summary **while the session is still warm** (the input is
cached, so the save costs little), then continue in a **fresh session** that
reads only the summary.

## When to save

- When the user says the limit is near, or `/usage` shows the budget running
  out.
- Before the session goes idle for longer than the cache lifetime (minutes).
- After every meaningful milestone, even mid-work — the file is cheap to
  rewrite and it is the recovery point if the session dies.

## Save protocol

Write `.claude/session-handoff.md` at the project root. Rewrite it from the
current context — do not append. Keep it under ~12 KiB (~4k tokens): the
whole point is that reading it back is cheap.

Sections (drop empty ones):

```markdown
# Session handoff

Saved: <timestamp> · Objective: <one line>

## State
- Repo: <path>, branch <branch>, HEAD <sha>, uncommitted: <summary>

## Progress
- <what shipped — commit hashes, files, verification results>

## Decisions
- <what was decided, by whom, and why>

## Pending
1. <next concrete action with exact files and commands>

## Open questions
- <what needs the user before continuing>

## Files to re-read
- <paths>

## Gotchas
- <failures, quirks, workarounds discovered>
```

Delete the previous handoff only after the new one is written.

Then tell the user the one-line resume instruction: "Start a new session in
this repo; the SessionStart hook injects `.claude/session-handoff.md`
automatically."

## Resume protocol (fresh session)

1. The handoff file is injected into context at session start when the
   SessionStart hook is configured — read it. Without the hook, read
   `.claude/session-handoff.md` manually.
2. Verify state before trusting it: git status/log, run directories, open
   processes. The handoff is a memory, not the truth.
3. Answer open questions only if the user already answered them; otherwise
   ask.
4. Delete `.claude/session-handoff.md` once absorbed — or keep rewriting it
   while the work continues; the next save replaces it anyway.

## Wiring the SessionStart hook

If the project has no hook yet, configure one in `.claude/settings.json`
(`.claude/hooks/session-start.mjs` in the skills repository is a reference
implementation):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/session-start.mjs" }
        ]
      }
    ]
  }
}
```

The hook injects the file as context only when it exists and is fresher than
48 hours, so stale handoffs do not pollute new sessions. A handoff older than
that should be rewritten or deleted, not read.

## Guardrails

- The summary is curated by the session that did the work, while the context
  is warm. A script that summarizes the transcript offline pays full price
  and loses judgment — never do that.
- Do not let a session auto-continue past the limit with a fat context. Save
  and start fresh instead; the fresh session costs a few thousand tokens no
  matter when it starts.
- One handoff per project. If several repos changed, summarize the others
  under "State".
