# AGENTS.md — {{PROJECT}}

> Quick links: [Architecture](docs/ARCHITECTURE.md) · [Abstractions](docs/ABSTRACTIONS.md) · [Vision](docs/VISION.md) · [Getting Started](docs/GETTING-STARTED.md) · [ADRs](docs/adr/README.md) · [Sentrux](docs/sentrux.md)
>
> *Playbook structure inspired by [tolaria](https://github.com/refactoringhq/tolaria); gate by [Sentrux](https://github.com/sentrux/sentrux).*

Critical guardrails for this repository — read before writing code or opening a PR.

---

## 1. Privacy & secrets (hard rules)

These come first because violations are the hardest to undo.

- **Never commit secrets.** Tokens, credentials, and service-account JSON stay in a secret manager or local `.env` (gitignored).
- **No personal data in shared source.** Never hardcode personal counterparties, account labels, fingerprints, or production-derived values into source, migrations, fixtures, tests, or docs. User-specific patterns belong in runtime configuration.
- **Fixtures are synthetic.** All committed fixtures and test data must be plausible-but-fake. If a real bug needs a real-data repro, reproduce it locally and translate the failure into a synthetic test.
- **Bug fixes vs. data fixes.** If a real-user bug requires a data correction, implement the generic engine support in shared code, then apply the private rule or data fix outside this repository.
- **Never expose internals to users.** No stack traces, internal URLs, or env var names in user-facing copy.

---

## 2. Task workflow

### 2a. Pick up a task

- Read the issue fully, including comments.
- Check `docs/adr/` for relevant architecture decisions before any structural choice.
- For bug fixes: reproduce first, then write a failing regression test when practical, then fix.

### 2b. Implement

- Branch from `main` (worktree when possible); open a focused PR with Conventional Commit titles.
- Commit every 20–30 min: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- **Never `--no-verify`.** If a hook blocks, fix the underlying issue.
- Keep changes scoped — no opportunistic refactors in feature PRs.

### 2c. Before declaring done

```bash
{{CHECK_SUITE}}
sentrux check .
sentrux gate .
```

---

## 3. Development process

### Commits & PRs

- **Conventional Commits required** — release tooling derives `CHANGELOG.md` and the next version from them.
- One logical change per commit; one bounded scope per PR.
- Use `feat!:` or a `BREAKING CHANGE:` footer for breaking changes.
- A PR is not ready to merge until CI is green.

### TDD (mandatory for behavior changes)

Red → Green → Refactor → Commit. One cycle per commit.

- Bug fixes: failing regression test first when testable.
- New logic: unit tests close to the change.
- Exception: pure docs, formatting, or copy tweaks with no code-path change.

**Test quality (Kent Beck's Desiderata):** Isolated · Deterministic · Fast · Behavioral · Structure-insensitive · Specific · Predictive. Fix flaky tests first.

### End-to-end tests (mandatory for key features)

Any key feature or user-visible change to a primary workflow must add or update an
E2E scenario. Unit tests remain mandatory for logic but do not replace an E2E
regression test.

E2E fixtures must be synthetic, deterministic, and isolated from the user's real
data, credential store, network providers, and production database. Use stable
selectors/identifiers; never use sleeps. An exception is allowed only for docs,
formatting, or behavior-preserving internal refactors, and must be stated in the PR.

### Check suite (runs on every push / PR)

```bash
{{CHECK_SUITE}}           # types + tests
sentrux check .           # architectural rules (.sentrux/rules.toml)
sentrux gate .            # no structural regression vs baseline
```

CI mirrors this — see `.github/workflows/quality.yml`.

### Code conventions

- **Language:** code, comments, identifiers in **English**.
- **Surgical changes.** Match existing style; don't refactor unrelated code.
- **Validate at boundaries.** Don't bypass schema validation with `any`.
- **Errors carry context.** No silent `unwrap`/`!`/bare `catch` in production paths — only in tests and clearly proven invariants.
- **Queries are parameterized**, never string-interpolated. Identifiers that cannot be bound go through an explicit allowlist.
- **No suppression comments** to silence a linter. Fix the code.

### Code health gate — Sentrux (mandatory)

[Sentrux](https://github.com/sentrux/sentrux) is the structural-quality sensor for this repo. Full reference: [docs/sentrux.md](docs/sentrux.md).

`check` enforces absolute limits (`.sentrux/rules.toml`); `gate` enforces *no regression* vs. the committed baseline (`.sentrux/baseline.json`).

```bash
sentrux check .           # CI-friendly; exits 0 if rules pass, 1 if not
sentrux gate --save .     # snapshot baseline before editing existing files
sentrux gate .            # compare current vs baseline; fails on degradation
```

- **Before a task on existing files**, run `sentrux gate --save .` to capture the baseline.
- **Before committing**, run `sentrux gate .`. Degradation on a touched file → refactor, don't commit.
- **Boy Scout Rule**: every file you touch leaves with an equal-or-better score.
- **New files** must pass `sentrux check .` cleanly — no findings, no warnings.
- **Never silence a rule** to pass. The gate is a ratchet — only direction is up.

### Coverage & dependency gates

- Coverage is a release gate, not a vanity metric. For bug fixes add a regression test when practical; for new behavior add coverage close to the changed code.
- Vulnerability and license scans block on new advisories or disallowed licenses. Resolve the finding — never silence it.

### ADRs & docs

ADRs live in `docs/adr/`. Create one in the same commit as the code that implements the decision. Never edit an active ADR — supersede it with a new one. Use `/create-adr`.

**When to create an ADR**

- A new dependency that changes the surface area (new backend, new external service, new provider).
- A storage strategy or schema convention change.
- A new platform target or distribution channel.
- A core abstraction (new trait/protocol, new domain model, change to a central store).
- A hosting or secrets strategy change.
- A cross-cutting pattern future contributors must follow.

**Not for:** behavior-preserving bug fixes, refactors that preserve behavior, dependency version bumps, formatting, copy tweaks.

After a structural change, update `docs/ARCHITECTURE.md` and/or `docs/ABSTRACTIONS.md` in the same commit. `ARCHITECTURE.md` reflects **active** decisions only — a superseded decision is replaced, not appended.

### Destructive actions

Merging, force-pushing, changing repository permissions, dropping schema, and
deleting data require explicit human sign-off in the moment. An agent that hits this
gate hands off to the user rather than routing around it.

### {{PROJECT}}-specific gotchas (hard-won — don't re-learn these)

Record here every failure that cost real debugging time, with the invariant that
prevents it and a link to the ADR or code that must not be undone. This section is
the highest-value part of the file — keep appending to it.

- _(none yet)_

---

## 4. Release-readiness checklist

- [ ] `{{CHECK_SUITE}}` passes locally.
- [ ] `sentrux check .` passes; `sentrux gate .` shows no degradation on touched files.
- [ ] CI is green on the PR.
- [ ] Key user-visible behavior has a deterministic E2E regression and the E2E check is green.
- [ ] No secrets, tokens, internal URLs, or personal data in the diff (`grep` it before pushing).
- [ ] If a public flag, command, or contract changed: `README.md` is updated.
- [ ] If a structural decision was made: an ADR exists and `docs/adr/README.md` index is updated.
- [ ] Conventional Commit title — release tooling parses it.

---

## 5. Reference

### Layout

```
src/                      Source
docs/
  adr/                    Architecture decision records (numbered, immutable)
  *.md                    Vision, architecture, abstractions, getting-started
.sentrux/                 Structural quality gate config + baseline
githooks/                 commit-msg + pre-commit (installed via core.hooksPath)
.github/workflows/        CI
```

### Useful commands

```bash
{{CHECK_SUITE}}
sentrux check . && sentrux gate .
```

### Versioning & release

Release Please reads Conventional Commits on `main` and opens a release PR with the
next version + CHANGELOG. Merging that PR cuts a GitHub Release and CI publishes the
artifacts.
