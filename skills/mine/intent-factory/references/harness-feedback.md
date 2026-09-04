# Ambient rendering by harness

Addendum 01 section 6 (B1.7). ADR-0020 renders continuous liveness from a
derived local artifact (`heartbeat.json`) at zero token cost. Claude Code is
the only harness the addendum verified; this reference records, per harness,
whether a documented mechanism exists for a human at the keyboard to see that
artifact without spending model context.

This is a research node: it names mechanisms and cites the documentation that
was actually consulted. A mechanism without an official documentation URL is
marked `unverified` and is never described as available. No adapter is
implemented here.

## Mechanisms

| Harness | Mechanism | Token cost | Official documentation URL | Verified on | Status |
| --- | --- | ---: | --- | --- | --- |
| claude | `statusLine` command in `settings.json` (`type: "command"`, `command`, optional `refreshInterval` seconds and `padding`); the script receives session JSON on stdin and its stdout becomes the bar | zero | https://code.claude.com/docs/en/statusline | 2026-09-04 | verified |
| codex | none documented in the consulted configuration reference | — | https://github.com/openai/codex/blob/main/docs/config.md | 2026-09-04 | unverified |
| opencode | none documented; `attention` covers TUI desktop notifications and sounds, not an external-command status bar | — | https://opencode.ai/docs/config/ | 2026-09-04 | unverified |
| pi | extension API `ctx.ui.setStatus(key, text)` (footer status) and `ctx.ui.setWidget(key, lines)` (persistent widget), rendered from a TypeScript extension | zero | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md | 2026-09-04 | verified |
| agy | `/statusline` manages the status indicator panel and runs custom formatted status-line shell scripts; the `notifications` setting fires a desktop notification and terminal bell on completion or attention | zero | https://antigravity.google/docs/cli/settings/ | 2026-09-04 | verified |
| cursor | `hooks.json` (`.cursor/hooks.json`, `~/.cursor/hooks.json`) spawns external processes over stdio JSON on events such as `sessionStart`, `stop` and `afterAgentResponse`; no continuously refreshed status bar is documented | zero | https://cursor.com/docs/hooks | 2026-09-04 | verified (event hooks only) |

## Notes per harness

- **claude** — the shipped channel. `statusline/claude-code.sh` reads the
  newest bounded heartbeat and prints one line; `refreshInterval` keeps it
  current while the session is idle. Documented in
  [feedback.md](feedback.md).
- **codex** — the consulted configuration reference documents
  `allow_managed_hooks_only` (which hook sources are honoured) but no
  status-line or ambient-rendering key. Third-party posts describe a `notify`
  program hook; none of them is official documentation, so nothing is claimed
  here. A later pass may re-read the reference once it documents the hook
  surface.
- **opencode** — `attention` produces TUI notifications and sounds, which is
  a discrete-event channel, not continuous liveness, and it renders the
  harness's own state rather than an external artifact.
- **pi** — the mechanism is in-process: an extension pushes footer status or
  widget lines. There is no documented timer that runs an external command,
  so an adapter would be a small extension that reads `heartbeat.json` on its
  own interval.
- **agy** — the closest analogue to the Claude Code channel: a shell script
  formats the status line, so the same bounded reader could serve it.
- **cursor** — hooks are event driven. They can push a discrete event (a
  desktop notification on `stop`, for example) but the documentation
  describes no bar that re-renders on a timer, so ambient liveness stays
  unproven for cursor.

## Next implementation nodes

Only verified mechanisms qualify. Each stays a separate node; none is code in
B1.7.

1. **agy status line adapter** — reuse the bounded heartbeat reader behind
   `/statusline`, matching the Claude Code contract (one line, at most 160
   characters, silent degradation, no git and no network).
2. **pi status extension** — a minimal extension calling
   `ctx.ui.setStatus` with the same bounded line, owning its own refresh
   interval because pi documents no timer.
3. **cursor event push** — a `stop`/`sessionEnd` hook that drains the
   campaign outbox through the existing generic notify transport. This is a
   push channel, not ambient rendering, and it must respect the pull-only
   boundary: `campaign.progress` is never routed to a session.

Re-verify every row before building an adapter: an unverified row here means
the documentation did not describe the mechanism on the verification date,
not that the harness cannot do it.
