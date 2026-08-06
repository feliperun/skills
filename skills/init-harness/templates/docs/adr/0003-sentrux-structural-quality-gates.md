---
type: ADR
id: "0003"
title: "Sentrux structural quality gates"
status: active
date: {{DATE}}
---

## Context

Type checks (`tsc`/equivalent) and tests catch type errors and behavior
regressions, but they are **blind to structure**: rising coupling, import
cycles, complexity hotspots, and files quietly turning into god objects. These
are exactly what makes a small, healthy codebase slow and fragile a year later.

Tolaria solved this with [Sentrux](https://github.com/sentrux/sentrux),
a structural-quality sensor that scores the dependency/call graph and ratchets
against regression. We adopt the same pattern while the repo is small enough to
set a clean baseline.

## Decision

**Adopt Sentrux as a mandatory structural-quality gate**, in three parts:

1. **`.sentrux/rules.toml`** — absolute hard limits (`check`).
2. **`.sentrux/baseline.json`** — committed reference for regression detection (`gate`).
3. **CI** — `sentrux check .` on every push/PR; `sentrux gate .` on PRs.

The Boy Scout Rule applies: any file a change touches leaves with an
equal-or-better structural score. Full reference: [../sentrux.md](../sentrux.md).

## Options considered

- **Sentrux with ratchet** (chosen): quantitative graph-level metrics; ships an
  MCP server so AI agents optimize the same score; complements `tsc`/tests.
- **Linter complexity rules only**: no project-wide coupling grade, no cycle
  detection, no baseline ratchet.
- **CodeScene**: richer but a hosted service, heavier than needed early.
- **Manual review for structure**: does not scale, invisible to agents.

## Consequences

- Contributors run `sentrux gate --save .` before a refactor and
  `sentrux check . && sentrux gate .` before committing.
- CI failure on a Sentrux violation blocks merge.
- Thresholds **only tighten**; loosening requires a superseding ADR. Never add
  ignore rules to pass — fix the structure.
- The committed baseline moves **up only**.
