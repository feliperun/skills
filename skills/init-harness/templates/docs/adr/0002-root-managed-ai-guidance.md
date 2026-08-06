---
type: ADR
id: "0002"
title: "Root-managed AI guidance files"
status: active
date: {{DATE}}
---

## Context

Multiple AI tools (Cursor, Claude Code, Gemini CLI, Copilot) expect project
instructions at the repository root. Duplicated `CLAUDE.md`, `GEMINI.md`, etc.
drift quickly. Tolaria established `AGENTS.md` as the single canonical playbook
with tool-specific shims.

## Decision

**`AGENTS.md` at the repo root is the canonical AI + contributor guidance.
Tool-specific files (`CLAUDE.md`, `GEMINI.md`, `CURSOR.md`) are symlinks to
`AGENTS.md`.** Update guidance in one place only.

## Options considered

- **AGENTS.md canonical + symlinks** (chosen): one source of truth; matches
  modern agent conventions (tolaria ADR-0065).
- **CLAUDE.md only**: works for Claude; other tools miss shared guardrails.
- **Separate full files per tool**: guaranteed drift.

## Consequences

- PRs that change workflow, checks, or guardrails edit `AGENTS.md` once.
- Coding agents prefer links into `docs/` over inflating the root file.
- A broken symlink on a platform without symlink support falls back to a regen
  step (`init-harness --force`).
