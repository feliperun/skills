/**
 * Where the eval tree lives, and how a bad invocation is refused.
 *
 * `UsageError` is its own class so `main` can tell a misuse (exit 2, print the
 * usage line) from a failing eval (exit 1, print what failed). Separate module
 * because case materialisation, comparison and the golden set all need the root
 * and the refusal, and having them in `run.mjs` made all three import the
 * entry point back.
 */
import { fileURLToPath } from "node:url";

export const EVALS_ROOT = fileURLToPath(new URL(".", import.meta.url));
/** @param {string} message @returns {never} */
export function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: evals/run.mjs (--class deterministic | --case <id> | --verify-discriminating | --compare <before.json> <after.json> | --project <runDir>... [--campaign <id>] [--note <text>] | --validate-golden --min <n> | --verify-fixtures) [--assert-no-model] [--json]\n",
  );
  process.exitCode = 2;
  throw new UsageError(message);
}
export class UsageError extends Error {}
