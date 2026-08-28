#!/usr/bin/env node
/**
 * skills — install skills from this repository into an agent's skills directory.
 *
 * Usage:
 *   skills [--target <dir>] [--global] [--force]
 *   skills <skill-name>... [--target <dir>] [--global] [--force]
 *   skills list
 *
 * Installs from `skills/mine/` under `.claude/skills/` of the current
 * directory. `--global` targets `~/.claude/skills/`. An existing skill is
 * kept unless `--force` removes and recopies it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));
const SKILLS_DIR = join(SKILLS_ROOT, "mine");

const USAGE = `usage:
  skills [--target <dir>] [--global] [--force]
  skills <skill-name>... [--target <dir>] [--global] [--force]
  skills list
  skills --help | --version

installs skills into .claude/skills/ of the current directory (or <dir> with
--target, or ~/.claude/skills/ with --global).`;

/** @param {string} [message] */
function usageError(message) {
  if (message) process.stderr.write(`skills: ${message}\n\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

/**
 * @returns {string[]} skill names that carry a SKILL.md
 */
function catalog() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{names: string[], list: boolean, global: boolean, force: boolean, target: string | null, help: boolean, version: boolean}} */
  const opts = {
    names: [],
    list: false,
    global: false,
    force: false,
    target: null,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      const value = argv[++i];
      if (!value) usageError("--target needs a directory");
      opts.target = value;
    } else if (arg.startsWith("--target=")) {
      opts.target = arg.slice("--target=".length);
    } else if (arg === "--global") {
      opts.global = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "list") {
      opts.list = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--version") {
      opts.version = true;
    } else if (arg.startsWith("-")) {
      usageError(`unknown flag ${arg}`);
    } else {
      opts.names.push(arg);
    }
  }
  return opts;
}

function list() {
  for (const name of catalog()) process.stdout.write(`${name}\n`);
}

/**
 * @param {string[]} names
 * @param {string} skillsDir
 * @param {boolean} force
 */
function install(names, skillsDir, force) {
  const available = new Set(catalog());
  /** @type {string[]} */
  let selected = [];
  if (names.length) {
    for (const name of names) {
      if (!available.has(name)) usageError(`no skill named "${name}" (run \`skills list\`)`);
    }
    selected = names;
  } else {
    selected = catalog();
  }
  mkdirSync(skillsDir, { recursive: true });
  let installed = 0;
  let skipped = 0;
  for (const name of selected) {
    const source = join(SKILLS_DIR, name);
    const destination = join(skillsDir, name);
    if (existsSync(destination) && !force) {
      process.stdout.write(`skipped ${name} (exists, use --force)\n`);
      skipped++;
      continue;
    }
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
    process.stdout.write(`installed ${name} → ${skillsDir}\n`);
    installed++;
  }
  process.stdout.write(`${installed} installed, ${skipped} skipped\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (opts.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (opts.list) {
    list();
    return;
  }
  const skillsDir = opts.global
    ? join(homedir(), ".claude", "skills")
    : join(opts.target ? resolve(opts.target) : process.cwd(), ".claude", "skills");
  install(opts.names, skillsDir, opts.force);
}

main();
