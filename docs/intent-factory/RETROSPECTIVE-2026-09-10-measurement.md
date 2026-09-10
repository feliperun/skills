# Retrospective: the measurement campaign (C0 + C1)

- **Campaign** `intent-factory-measurement-20260910`
- **Spec** [TECH-SPEC-2026-09-09.md](TECH-SPEC-2026-09-09.md), blocks C0 and C1
- **Baseline** `90e1317` · **Head** `1db1b97`
- **Runs** 6 · **Cost** USD 58.66 · **Supervisor** Claude Opus 5 · **Worker** claude-sonnet-5 · **Judge** claude-opus-5

## Delta

| Indicator | Before | After |
|---|---|---|
| CI on `main` | red, every job, for days | green, 4/4 jobs |
| Suite with no provider CLI on `PATH` | 2 failures | 0 failures, 516 pass |
| Deterministic evals | absent | 13 cases, each proven able to fail |
| Golden set | absent | 26 tasks, all restoring from one shared bundle |
| Comparator | absent | 8 indicators, `null` where unmeasured |
| Baseline | absent | `evals/baseline.json` |
| Evals in CI | absent | both the pass check and the discriminator check |

## What the campaign found

Three items the spec assumed were expressible turned out to describe behavior
production does not have. They are recorded here because an eval written for a
behavior that does not exist is exactly the tautological test this campaign
spent its budget removing.

- **D06** — `insufficient_balance` exists only in `normalizeProviderAvailability`
  (`drivers/index.mjs:205-207`), but the live path runs through `probeRuntime`,
  whose close handler collapses every non-`ENOENT` failure into
  `provider_unavailable` (`drivers/index.mjs:361-390`). The distinction the case
  would pin does not happen at runtime. `124f34e`
  (`deepseek-balance-classification`) appears to have covered one path only.
- **D08** — `validateContract` compares only the primary worker and judge
  vendors (`contract.mjs:234-244`). The runtime refusal at `node.mjs:2562-2566`
  covers a different case and is deliberate: a *judge's* fallback landing on the
  worker's vendor depends on which worker actually ran, which a static contract
  cannot know. But the case `SKILL.md` describes — a *worker's* declared
  fallback sharing the judge's vendor — is statically knowable and is simply not
  validated.
- **D09** — there is no `ENOSPC` handling and no `.runs/` GC anywhere in the
  production tree. Nothing exists to pin.

**D04** was the fourth omission and was fixable: the `replay` driver dropped
`resetAt`/`exhaustedUntil` in `canonicalError`, so the scheduled-reset branch
was unreachable through it. Extending a driver that exists only for testing to
carry the fields real drivers produce is making it fit for its own purpose, so
the case now exists.

## What went wrong, and what it cost

**Two runs blocked on an incomplete write scope — USD 7.37, zero items closed.**
The packet enumerated `writeFiles`; the fixture guard's blast radius turned out
to be six files, and each run discovered the next one. The orchestrator owns
discovery: a deterministic scan up front found all 32 runtime literals in one
command. Switching to `mode: autonomous` with `writeRoots` scoped to the test
directory removed the failure class, and every node after that passed on its
first or second attempt.

**Gates were not gating.** `review-modes.mjs` defaults to `advisory`, so a gate
without an explicit `review` records findings and still lets the node reach
`done` — including at `major` severity. Every contract in this campaign up to
C1-a had this defect. It surfaced when the judge correctly reported that D01
proved nothing and the node closed anyway.

**A worker's green is not a proof.** D01 passed with its recovery step deleted
entirely. The guard test passed without anyone checking it could fail. Both
were caught by mutating the artifact and requiring the failure — the guard by
injecting a violation into a real fixture, D01 by removing the step it claimed
to exercise. `--verify-discriminating` makes that check mechanical for every
case, and the judge then found the hole in it: a single-step case whose
discriminator deletes the run itself passes vacuously.

**Measuring once on a quiet host is not measuring.** This host was shared with
another agent session running the same suite. `npm run check` measured 3.3 s
quiet and 118.4 s under contention; the full suite measured 141.5 s quiet and
982.9 s under load — past the 600 s per-entry cap, so it can never be a
verification entry. This is the same shape as the field defect the previous
retrospective recorded: a packet declaring `timeoutSec: 600` for a file that
took 644.8 s.

**A packet that writes to `.github` must verify `test/ci-policy.test.mjs`.**
Wiring the evals into CI broke a test that pins the exact step list. Node
verification did not include it; the out-of-band suite caught it.

## Carried forward

- Every gate declares `review: "blocking"`. An advisory judge is an expensive
  no-op.
- Every deterministic case declares a `discriminator`, and the guard rejects a
  degenerate one.
- Artifacts are JSON, not the YAML the spec's layout named: no YAML parser
  exists in the repo or in Node, and the whole state layer is already JSON.
- One shared `fixtures.bundle`, not one per task: 689 KiB per shallow bundle
  times 25 tasks is 17 MiB of near-duplicate binary against 1.6 MiB sharing the
  common history.
- `finalVerification` is never the full suite. The phase invariant is what fits
  the cap; the orchestrator runs the suite out of band.

## Open

- D06, D08 and D09 need production changes before their evals can exist.
- The `SKILL.md` claim about fallback vendors contradicts `node.mjs`.
- `evals/baseline.json` holds this campaign's measurement, not suite-speed's:
  that campaign's run directories are no longer in this tree. ADR-0023's
  before-and-after delta starts from here.
