/**
 * `contract validate`: validate an authored contract from the command line and
 * print the report the authoring turn reads (TECH-SPEC lean, rule 4: a
 * partly finished run is continued by `resume`, never re-authored, so this is
 * the only contract operation the CLI carries).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateContract } from "../contract/index.mjs";

/** @typedef {import("../contract/index.mjs").ValidatedContract} ValidatedContract */

/** Flags are scoped to the operation that declares them; all others are rejected. */
/** @type {Record<string, import("node:util").ParseArgsOptionsConfig>} */
const OPERATION_OPTIONS = {
  validate: {},
};

/**
 * @param {string[]} args
 * @returns {void}
 */
export function contractCli(args) {
  const operation = args[0];
  if (!operation || !Object.hasOwn(OPERATION_OPTIONS, operation)) return usage();
  const target = args[1];
  if (!target || args.length > 2) return usage();
  if (operation === "validate") validateContractFile(resolve(target));
}

/**
 * Validate an authored contract and print the same report the `validate`
 * command has always printed. A single-node contract is simply valid.
 *
 * @param {string} path
 * @returns {ValidatedContract}
 */
export function validateContractFile(path) {
  const contract = validateContract(JSON.parse(readFileSync(path, "utf8")), path);
  const count = contract.warnings.length;
  process.stdout.write(`valid${count ? ` (${count} warning${count === 1 ? "" : "s"})` : ""}\n`);
  for (const warning of contract.warnings) process.stdout.write(`[warn] ${warning}\n`);
  return contract;
}

/** @returns {void} */
function usage() {
  process.stderr.write("usage: runner.mjs contract validate <contract.json>\n");
  process.exitCode = 2;
}
