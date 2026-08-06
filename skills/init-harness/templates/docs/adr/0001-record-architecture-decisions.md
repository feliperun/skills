---
type: ADR
id: "0001"
title: "Record architecture decisions"
status: active
date: {{DATE}}
---

## Context

As {{PROJECT}} grows with multiple contributors and AI agents, decisions get
scattered across chat history and commit messages, making it hard to know *why*
the system looks the way it does.

## Decision

**Use Architecture Decision Records in `docs/adr/` following the tolaria
playbook.** Each structural choice gets a numbered, immutable record; changes
supersede prior ADRs instead of editing them.

## Options considered

- **ADR folder with frontmatter** (chosen): proven in tolaria; works for
  humans and coding agents; index in `README.md`.
- **Only a learnings doc**: lightweight but mixes incidents with irreversible
  architecture choices.
- **Wiki / external docs**: fine for product, poor for version-controlled
  coupling to code.

## Consequences

- New structural work adds or supersedes an ADR in the same PR.
- `docs/ARCHITECTURE.md` summarizes current state; ADRs hold the history.
- Agents read `docs/adr/` before large refactors (see `AGENTS.md`).
