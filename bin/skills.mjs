#!/usr/bin/env node
/**
 * skills — install skills from this repository into an agent's skills directory.
 *
 * Usage:
 *   skills [--category <mine|curated|community|all>]... [--target <dir>] [--global] [--force]
 *   skills <skill-name>... [--target <dir>] [--global] [--force]
 *   skills list [--category <bucket>]...
 *
 * Defaults: the `mine` category, installed under `.claude/skills/` of the
 * current directory. `--global` targets `~/.claude/skills/`. An existing
 * skill is kept unless `--force` removes and recopies it.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));
const BUCKETS = ["mine", "curated", "community"];

const USAGE = `usage:
  skills [--category <mine|curated|community|all>]... [--target <dir>] [--global] [--force]
  skills <skill-name>... [--target <dir>] [--global] [--force]
  skills list [--category <bucket>]...
  skills --help | --version

installs skills into .claude/skills/ of the current directory (or <dir> with
--target, or ~/.claude/skills/ with --global). default category: mine.`;

/** @param {string} [message] */
function usageError(message) {
  if (message) process.stderr.write(`skills: ${message}\n\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

/**
 * @param {string} bucket
 * @returns {string[]} skill names in the bucket that carry a SKILL.md
 */
function skillsIn(bucket) {
  const dir = join(SKILLS_ROOT, bucket);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{categories: string[], names: string[], list: boolean, global: boolean, force: boolean, target: string | null, help: boolean, version: boolean}} */
  const opts = {
    categories: [],
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
    if (arg === "--category") {
      const value = argv[++i];
      if (!value) usageError("--category needs a bucket name");
      opts.categories.push(value);
    } else if (arg.startsWith("--category=")) {
      opts.categories.push(arg.slice("--category=".length));
    } else if (arg === "--target") {
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
  const categories = opts.categories.length ? opts.categories : ["mine"];
  for (const category of categories) {
    if (category !== "all" && !BUCKETS.includes(category)) {
      usageError(`unknown category "${category}" (mine, curated, community, all)`);
    }
  }
  return { ...opts, categories };
}

/** @returns {Record<string, string[]>} skill names per bucket */
function catalog() {
  /** @type {Record<string, string[]>} */
  const result = {};
  for (const bucket of BUCKETS) {
    const names = skillsIn(bucket);
    if (names.length) result[bucket] = names;
  }
  return result;
}

/** @returns {Record<string, string>} skill name -> bucket */
function byName() {
  /** @type {Record<string, string>} */
  const result = {};
  for (const [bucket, names] of Object.entries(catalog())) {
    for (const name of names) {
      if (result[name]) result[name] = "*ambiguous*";
      else result[name] = bucket;
    }
  }
  return result;
}

function list() {
  const catalogEntries = catalog();
  for (const bucket of BUCKETS) {
    const names = catalogEntries[bucket];
    if (!names) continue;
    const marker = bucket === "mine" ? "⭐" : bucket === "curated" ? "💎" : "";
    process.stdout.write(`${bucket} ${marker}\n`);
    for (const name of names) process.stdout.write(`  ${name}\n`);
  }
}

/**
 * @param {string[]} names
 * @param {string[]} categories
 * @param {string} skillsDir
 * @param {boolean} force
 */
function install(names, categories, skillsDir, force) {
  const lookup = byName();
  /** @type {Array<{name: string, bucket: string}>} */
  const selected = [];
  if (names.length) {
    for (const name of names) {
      const bucket = lookup[name];
      if (!bucket) usageError(`no skill named "${name}" (run \`skills list\`)`);
      if (bucket === "*ambiguous*") usageError(`"${name}" exists in more than one bucket; rename one of them`);
      selected.push({ name, bucket });
    }
  } else {
    const wanted = categories.includes("all") ? BUCKETS : categories;
    for (const bucket of wanted) {
      for (const name of skillsIn(bucket)) selected.push({ name, bucket });
    }
  }
  mkdirSync(skillsDir, { recursive: true });
  let installed = 0;
  let skipped = 0;
  for (const { name, bucket } of selected) {
    const source = join(SKILLS_ROOT, bucket, name);
    const destination = join(skillsDir, name);
    if (existsSync(destination) && !force) {
      process.stdout.write(`skipped ${name} (exists, use --force)\n`);
      skipped++;
      continue;
    }
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
    process.stdout.write(`installed ${name} (${bucket}) → ${skillsDir}\n`);
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
  install(opts.names, opts.categories, skillsDir, opts.force);
}

main();
