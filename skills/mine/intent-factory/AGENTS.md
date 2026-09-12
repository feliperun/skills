# AGENTS.md — intent-factory

The repository root `AGENTS.md` still applies. This file is the rules for *this
codebase*, and every rule here is either enforced by a test or is a decision you
can check against the tree in one command. A rule nobody can fail is decoration.

## Layout

`src/` is the source; nothing else under this skill is. Each directory is a
layer, and the layer names are the vocabulary:

| directory | owns |
| --- | --- |
| `cli.mjs`, `cli/` | argv, dispatch, usage. No domain logic. |
| `contract/` | the authored artefact: schema and validation. Reads only files the contract itself names (`taskPacketFile`); spawns nothing. |
| `engine/` | the control loop: scheduler, node lifecycle, routing, gates. |
| `harnesses/` | one adapter per provider harness, plus what each one can run. |
| `campaign/` | the durable layer above runs. |
| `repo/` | anything that touches the target repository: git, worktrees, the workspace. |
| `run/` | the `.runs/` directory: store, lock, ledgers, gc. |
| `report/`, `web/` | the two ways a human reads a run. Presentation only. |
| `host/` | facts about the machine. |
| `notify/` | notification transports. |
| `util.mjs` | helpers with no domain. Nothing imports a layer from here. |

`bin/` is the entry point and calls into `src/`. `test/` mirrors `src/`.
`docs/` and `evals/golden/` are historical record — see `docs/README.md` before
"fixing" a path in either.

## Enforced rules

These fail `npm test`. `test/repo/source-shape.test.mjs` is where they live.

- **No file over 800 lines.** Counted on every `.mjs` under this skill. A file
  that grows past it is doing more than one job; find the second job and give it
  a module. Raising the ceiling is not a fix.
- **No runtime import cycle in `src/`.** One is currently allowed by name
  (`engine/lifecycle.mjs` ↔ `engine/review.mjs`) and that allowance shrinks to
  zero, never grows. JSDoc `import("…")` type references do not count — they are
  erased at runtime.
- **No top-level body defined twice in `src/`.** Compared by body with the
  declaration's *name stripped*, because a copy that was renamed is still a
  copy — a name-keyed version of this gate let a byte-identical `compactCost`
  live on in `cli.mjs` as `formatCost`. If two modules need it, it has one home
  and both import it.
- **No name exported from two `src/` modules.** A module-private helper may
  share a name — a standalone spawned program with its own `fail` or `usage` is
  idiomatic and nobody can import it by mistake. Two *exported* ones is the
  hazard: this tree had two `stableJson`s (a comparator and a pretty-printer)
  and two `requireText`s, one of which read a file. `harness` is exempt by name:
  every adapter exports it, and that uniformity *is* the registry interface.
- **No barrel modules.** A module that only re-exports gives every symbol two
  homes and makes "where does this come from" unanswerable. `lib.mjs` was one;
  it is gone.
- **Empty `catch {}` blocks never increase**, asserted at the measured count
  (28) rather than a ceiling above it. A swallowed error either gets a body or
  a comment saying why the failure is genuinely uninteresting. Target is zero.
- **Every module header stays**, ratcheted the same way: the count of `src/`
  modules with no leading block comment (30 of 84) only falls.
- **No unused declaration anywhere.** `noUnusedLocals` is on, so `npm run
  typecheck` is the gate. Turning it on after the splits found 392 dead
  imports, typedefs and helpers, most of them left behind by the splits
  themselves.

## Conventions

- **Plain ESM `.mjs`, typed with JSDoc.** `npm run typecheck` runs `tsc` over
  the whole tree in checkJS mode and must be clean. It is not optional tooling:
  it has caught a merged helper that would have broken four git probes silently,
  and eleven type errors in a file that had been hiding inside a string.
- **A module's header comment says what it owns and why it is separate.** Not
  what its functions do — the reader can see that. Why *this* boundary.
- **Comments record measurement, not intent.** `measured 2026-09-11: …` with the
  number is worth ten lines of description. If a limit, a timeout or a retry
  count has no measurement behind it, say that too.
- **No dead exports.** If nothing imports it, delete it. Two "shared" numeric
  helpers survived here for months with exactly one reference each: their own
  definition. `noUnusedLocals` catches the module-private half of this; the
  exported half still needs a reader.
- **Name a function for what it does, not for what it resembles.** Two
  `requireText`s existed; one read a file. Two `stableJson`s existed; one was a
  pretty-printer.

## Extraction and refactoring

Splitting a module is mechanical and should be scripted, not retyped — but:

- **Run `node --check` after every step, not at the end.** A scripted extractor
  that tracks braces and not brackets will cut `new Set([…])` in half, and the
  result parses as far as the next file.
- **Beware template literals holding code.** Three separate tools of mine were
  fooled by them in one day: an import anchored on "the last `import` in the
  file" landed inside a generated worker program; a dead-code deleter cut a
  template's opening line and left its body; and a definition scanner treated
  the template's column-0 contents as top-level. Mask them, or anchor on the
  leading import block only.
- **Check the module dependency graph before choosing boundaries.** If two
  candidate modules point at each other, the shared thing usually wants to be a
  third module — that is where `contract/schema-version.mjs`, `campaign/layout.mjs`
  and `campaign/record.mjs` came from.
- **Historical artefacts are not stale paths.** A campaign contract under
  `docs/campaigns/` records what a worker was actually told. Editing it makes
  the record lie about a run that already happened.

## Tests

- `test/` mirrors `src/` by directory. File names follow the module where one
  exists and the behaviour otherwise (`test/engine/routing.test.mjs` covers
  several modules) — the directory is the rule, the file name is a preference.
- **A test that asserts a live model's exact words is not a test of this code.**
  Assert the envelope, the token count, the wire. One such assertion failed
  twice in a day on wording alone.
- **A verification duration is a measurement.** Before putting a command in a
  packet or a `verification` array, run it and know how long it takes.
