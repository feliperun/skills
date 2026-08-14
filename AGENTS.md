# AGENTS.md

Write the minimum code that runs. No fluff, no gold-plating.

- Do not preserve backward compatibility. Remove obsolete paths instead of adding
  compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements.
  Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end,
  and add each new capability on top of a product that already works. Never trade a
  working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity
  or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a capability
  without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only
  works for now and is meant to be replaced later.
- Study how established products solve the problem before designing a solution. Adopt
  their proven patterns and conventions rather than inventing an approach from scratch.

## Repository rules

- **`AGENTS.md` is the single source of guidance.** `CLAUDE.md`, `GEMINI.md`,
  `CURSOR.md`, `AGENT.md` and `.github/copilot-instructions.md` are symlinks to it.
  Never edit a symlink; never let one drift into a real file.
- **Templates are portable, this file is not.** Anything under a skill's
  `templates/` is copied into other repositories, so it must stay generic —
  placeholders (`{{PROJECT}}`, `{{CHECK_SUITE}}`, `{{DATE}}`,
  `{{SENTRUX_VERSION}}`), no project-specific paths, no personal data.
- **Never commit secrets.** Tokens, credentials, and service-account JSON stay in a
  secret manager or a gitignored `.env`. The `pre-commit` hook scans the staged diff;
  do not work around it.
- **Nothing from a private or employer repository lands here** without an explicit
  decision. This repo is intended to be public.
- **Conventional Commits required.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`. One logical change per commit.
- **Never `--no-verify`.** If a hook blocks, fix the underlying issue.
- **Shell scripts** run under `set -euo pipefail` and are idempotent — re-running
  completes what is missing instead of duplicating or destroying.

## Harness protocol

When using `run-harness`, the orchestrator owns repository discovery. Read the
campaign `HANDOFF.md`, attach the current session, and record concise material
events before delegating. Give every execution worker a closed task packet with
exact read files, write files, decisions, non-goals, and verification commands.
Only an explicit read-only discovery node may explore beyond a supplied packet.

## Production note

Rule 1 is written for side projects. Against a live system it can lead an agent to
equate "obsolete" with "safe to delete" and destroy data.

When this file governs anything in production:

- Soften rule 1: require migrations, backups, or explicit human approval before any
  destructive schema or data change.
- Weigh rule 1 against rule 7 case by case. Long-term correctness does not justify
  unreviewed destructive action against production data.
- Never grant an agent operating under this file unsupervised write or delete access
  to a production database.

---

Adapted from [Marcos Hernanz](https://x.com/MarcosHernanz/status/2083954734487212511).
`CLAUDE.md`, `GEMINI.md`, `CURSOR.md`, `AGENT.md` and `.github/copilot-instructions.md`
are symlinks to this file — edit `AGENTS.md` only.
