# Historical record

Everything in this directory is a record of work that already happened: tech
specs as they were written, retrospectives, and under `campaigns/` the exact
contracts, handoffs and control notes a campaign ran with.

**The paths in these files are the paths that existed when they were written.**
On 2026-09-11 and 2026-09-12 the source tree was reorganised, so a contract from
the September 2026 lean campaign names files that have since moved. They are not
broken links to fix — a contract records what a worker was actually told, and
rewriting it would make the record a lie about a run that already happened.

The mapping, if you are reading an old contract and want the file today:

| then | now |
| --- | --- |
| `scripts/*.mjs` | `src/<layer>/*.mjs` — see the table below |
| `scripts/drivers/<name>.mjs` | `src/harnesses/<name>/index.mjs` |
| `scripts/drivers/index.mjs` | `src/harnesses/index.mjs` |
| `scripts/runner.mjs` | `src/cli.mjs` |
| `scripts/lib.mjs` | `src/engine/prompts.mjs` (the barrel is gone) |
| `scripts/models.mjs` | `src/harnesses/catalogue.mjs` |
| `scripts/node.mjs` | `src/engine/lifecycle.mjs`, plus ten modules split out of it |
| `scripts/contract.mjs` | `src/contract/index.mjs`, plus five modules split out |
| `scripts/campaign.mjs` | `src/campaign/index.mjs`, plus five modules split out |
| `scripts/verification.mjs` | `src/contract/verification.mjs`, `src/repo/workspace.mjs`, `src/engine/run-command.mjs` |
| `dashboard/dashboard.mjs` | `src/web/server.mjs` |
| `statusline/claude-code.sh` | `integrations/claude-code/statusline.sh` |
| `docs/intent-factory/` | `docs/` (this directory, now inside the skill) |
| `evals/` | `evals/` (also now inside the skill) |

The layers under `src/`: `cli`, `contract`, `engine`, `harnesses`, `campaign`,
`repo`, `run`, `report`, `web`, `host`, `notify`.

The same applies to `evals/golden/*/verify.json`, for a sharper reason: each
golden task restores its own parent commit from a git bundle, and its recorded
verification commands belong to *that* tree. See `evals/README.md`.
