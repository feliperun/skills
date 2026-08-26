# Session Memory

A long session that survives a usage-limit reset is expensive twice: the
continuation re-reads the whole conversation without prompt cache. Instead,
save a curated summary **while the session is still warm** (the input is
cached, so the save costs little), then continue in a **fresh session** that
reads only the summary.

## Memory layers

Do not put everything in one place. Each layer has one owner and one lifetime:

| Layer | What it holds | Lives | Owner |
| --- | --- | --- | --- |
| Session handoff (this file) | episodic: what this conversation did and knows | `.claude/session-handoff.md`, ~48h, single-use | session-memory |
| Campaign handoff | the objective's durable state: decisions, outcomes, open questions, lineage | `.runs/<campaign>/HANDOFF.md` in the target repo, lives for the whole campaign | intent-factory |
| Agent auto-memory | semantic: standing facts about the user and the project | Claude Code memory directory | the harness |
| Skills and AGENTS.md | procedural: how work is done | repo, versioned | the repo |

The session handoff is the cheapest layer and the most disposable. Never
duplicate campaign state in it — point to the campaign instead.

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

If a intent-factory campaign is active (its signal block sits in the target
repo's `AGENTS.md`), flush the session's material events into the campaign
while the context is warm — the durable layer must not depend on anyone
remembering to journal later:

```bash
node <intent-factory>/scripts/runner.mjs campaign note <campaign> --cwd <repo> \
  --session-id <id> --kind decision|constraint|outcome|next-action|question --text <text>
```

Then reference the campaign in the handoff (one line) instead of duplicating
its state.

Then tell the user the one-line resume instruction: "Start a new session in
this repo; the SessionStart hook injects `.claude/session-handoff.md`
automatically."

## Resume protocol (fresh session)

1. The handoff file is injected into context at session start when the
   SessionStart hook is configured — read it. Without the hook, read
   `.claude/session-handoff.md` manually.
2. If the target repo's `AGENTS.md` carries a intent-factory signal block, the
   work has a durable layer: read `.runs/<campaign>/HANDOFF.md` for the
   campaign state, re-attach this session (`campaign attach`), and continue
   the run or `supervise` it. The session handoff only covers what is not
   yet in the campaign.
3. Verify state before trusting it: git status/log, run directories, open
   processes. A handoff is a memory, not the truth.
4. Answer open questions only if the user already answered them; otherwise
   ask.
5. Delete `.claude/session-handoff.md` once absorbed — or keep rewriting it
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

## References

The memory-layer taxonomy and the single-use handoff semantics draw on
[ai-memory](https://github.com/akitaonrails/ai-memory) by Akita on Rails.
Other patterns — compile-not-retrieve summaries, injecting the handoff before
the first prompt — developed independently here and match its design.
