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
