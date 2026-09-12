import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The rules `AGENTS.md` states about the shape of this source tree, enforced.
 *
 * Every one of these was a real defect first: a 3,888-line file doing nine jobs,
 * two modules importing each other through the CLI, `errorCode` defined eight
 * times in five behaviours, and a barrel that gave every symbol two homes. The
 * point of the file is that none of them can come back quietly.
 *
 * The tree is read once, at module scope, and every gate reads that snapshot.
 */

const SKILL_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(SKILL_DIR, "src");

/** No file in this skill may exceed this. A longer file is doing a second job. */
const LINE_CEILING = 800;

/**
 * Runtime import cycles allowed by name. Empty, and it stays empty: the entry
 * that used to be here (`engine/lifecycle.mjs` <-> `engine/review.mjs`) was
 * settlement living in `lifecycle.mjs` while `review.mjs` called it, and it is
 * gone now that `engine/settle.mjs` owns `settleDone` and the rejection paths.
 *
 * @type {string[][]}
 */
const ALLOWED_CYCLES = [];

/**
 * @param {string} dir
 * @returns {string[]} absolute paths of every `.mjs` file below `dir`
 */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith(".mjs")) found.push(path);
  }
  return found;
}

/** Every `.mjs` in the skill, read once. `src/` is a subset of it. */
const FILES = walk(SKILL_DIR).map((path) => ({
  path,
  label: relative(SKILL_DIR, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const SRC_FILES = FILES.filter((file) => file.path.startsWith(SRC_DIR + sep));

test(`no file in the skill exceeds ${LINE_CEILING} lines`, () => {
  const oversized = FILES
    .map((file) => ({ path: file.label, lines: file.text.split("\n").length }))
    .filter((file) => file.lines > LINE_CEILING)
    .sort((left, right) => right.lines - left.lines);
  assert.deepEqual(
    oversized,
    [],
    `over the ${LINE_CEILING}-line ceiling:\n${oversized.map((f) => `  ${f.lines}  ${f.path}`).join("\n")}\n` +
      "Find the second job the file is doing and give it a module. Do not raise the ceiling.",
  );
});

/**
 * Runtime import edges only, keyed by `src/`-relative module path.
 *
 * A JSDoc `import("./x.mjs").Type` is a type reference erased before the module
 * ever loads; counting those reports cycles that do not exist, as an earlier
 * version of this analysis did.
 *
 * @returns {Map<string, string[]>}
 */
function runtimeImportGraph() {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const file of SRC_FILES) {
    const source = file.text
      .replace(/\/\*(?:[^*]|\*(?!\/))*\*\//gu, " ")
      .replace(/\/\/[^\n]*/gu, " ");
    /** @type {Set<string>} */
    const specifiers = new Set();
    for (const match of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*"(\.[^"]+)"/gsu)) {
      specifiers.add(match[1]);
    }
    for (const match of source.matchAll(/\bimport\s*"(\.[^"]+)"/gu)) specifiers.add(match[1]);
    graph.set(
      relative(SRC_DIR, file.path).split(sep).join("/"),
      [...specifiers]
        .map((spec) => relative(SRC_DIR, join(file.path, "..", spec)).split(sep).join("/"))
        .sort(),
    );
  }
  return graph;
}

test("src/ has no runtime import cycle beyond the ones allowed by name", () => {
  const graph = runtimeImportGraph();
  /** @type {Set<string>} */
  const cycles = new Set();
  // Two-colour DFS over one shared colouring: grey is "on the current path", so
  // reaching a grey node is a cycle and reaching a black one is already done.
  /** @type {Map<string, "grey"|"black">} */
  const colour = new Map();
  /** @param {string} node @param {string[]} path */
  const visit = (node, path) => {
    colour.set(node, "grey");
    for (const next of graph.get(node) ?? []) {
      if (colour.get(next) === "grey") cycles.add(path.slice(path.indexOf(next)).sort().join(" <-> "));
      else if (!colour.has(next)) visit(next, [...path, next]);
    }
    colour.set(node, "black");
  };
  for (const node of graph.keys()) if (!colour.has(node)) visit(node, [node]);

  const allowed = new Set(ALLOWED_CYCLES.map((members) => [...members].sort().join(" <-> ")));
  assert.deepEqual(
    [...cycles].filter((cycle) => !allowed.has(cycle)).sort(),
    [],
    "new runtime import cycle in src/. The shared thing usually wants to be a third module.",
  );
  assert.deepEqual(
    [...allowed].filter((cycle) => !cycles.has(cycle)),
    [],
    "ALLOWED_CYCLES names a cycle that no longer exists -- delete the entry, the list only shrinks.",
  );
});

/**
 * Every top-level definition in `src/`: its module, its name, whether it is
 * exported, and its body normalized for comparison.
 *
 * A definition ends at the next line that closes at column 0. That is this
 * codebase's formatting invariant and it is the reason this does not count
 * brackets: a `{` inside a regex character class (`/^[\[{]/u` in
 * `harnesses/protocol.mjs`) made a bracket-counting version record a 7-line
 * function as spanning 453, hiding everything after it from these gates.
 *
 * @returns {{module: string, name: string, exported: boolean, body: string}[]}
 */
function srcDefinitions() {
  const found = [];
  for (const file of SRC_FILES) {
    const module = relative(SRC_DIR, file.path).split(sep).join("/");
    const lines = file.text.split("\n");
    for (const [index, line] of lines.entries()) {
      const match = /^(export\s+)?(?:async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (!match) continue;
      let end = index;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        end = scan;
        if (/^[}\])]/u.test(lines[scan])) break;
        if (/^\S/u.test(lines[scan])) { end = scan - 1; break; }
      }
      if (/;\s*$/u.test(line) && !/[{[(]\s*$/u.test(line)) end = index;
      found.push({
        module,
        name: match[2],
        exported: Boolean(match[1]),
        // the declaration line has its name stripped: a copy that was renamed
        // is still a copy, and that is how `compactCost` survived in `cli.mjs`
        // as `formatCost` through a name-keyed version of this check
        body: lines.slice(index, end + 1)
          .map((text) => text.trim())
          .join("\n")
          .replace(/^export /u, "")
          .replace(/^((?:async )?(?:function|class|const|let) )[A-Za-z_$][\w$]*/u, "$1"),
      });
    }
  }
  return found;
}

const DEFINITIONS = srcDefinitions();

test("no top-level body is defined twice in src/", () => {
  // Keyed on the body, never on the name. Keying on the name first is how a
  // byte-identical copy of `compactCost` survived in `cli.mjs` under the name
  // `formatCost`: the eight `errorCode` copies were only caught because they
  // happened to share a name.
  /** @type {Map<string, {name: string, module: string}[]>} */
  const byBody = new Map();
  for (const definition of DEFINITIONS) {
    // one-liners and trivial bodies collide by accident, not by duplication
    if (definition.body.split("\n").length < 3) continue;
    byBody.set(definition.body, [...(byBody.get(definition.body) ?? []), definition]);
  }
  const duplicated = [];
  for (const entries of byBody.values()) {
    const modules = [...new Set(entries.map((entry) => entry.module))];
    if (modules.length < 2) continue;
    const names = [...new Set(entries.map((entry) => entry.name))];
    duplicated.push(`${names.join("/")}: ${modules.sort().join(", ")}`);
  }
  assert.deepEqual(
    duplicated.sort(),
    [],
    `the same body in two modules:\n${duplicated.map((line) => `  ${line}`).join("\n")}\n` +
      "Give it one home and import it.",
  );
});

test("no name is exported from two src/ modules", () => {
  // A module-private helper may share a name -- a standalone spawned program
  // with its own `fail` or `usage` is idiomatic and nobody can import it by
  // mistake. Two *exported* ones is the hazard: this tree had two `stableJson`s
  // (a comparator and a pretty-printer) and two `requireText`s, one of which
  // read a file.
  //
  // `harness` is exempt and is the interface, not a collision: every adapter
  // under `harnesses/*/` exports it, which is what makes the registry uniform.
  const exempt = new Set(["harness", "driver", "default"]);
  /** @type {Map<string, Set<string>>} */
  const homes = new Map();
  for (const definition of DEFINITIONS) {
    if (!definition.exported || exempt.has(definition.name)) continue;
    homes.set(definition.name, (homes.get(definition.name) ?? new Set()).add(definition.module));
  }
  const collisions = [...homes.entries()]
    .filter(([, modules]) => modules.size > 1)
    .map(([name, modules]) => `${name}: ${[...modules].sort().join(", ")}`)
    .sort();
  assert.deepEqual(
    collisions,
    [],
    `one name exported from two modules:\n${collisions.map((line) => `  ${line}`).join("\n")}\n` +
      "Either they are the same function (give it one home) or they are not (rename one for what it does).",
  );
});

test("no src/ module is a barrel", () => {
  // A module that re-exports and defines nothing of its own gives every symbol
  // it forwards a second home.
  const barrels = SRC_FILES
    .filter((file) => /^export\s*\{[^}]*\}\s*from\s*"/mu.test(file.text))
    .filter((file) => !/^export\s+(?:async\s+function|function|const|let|class)\s/mu.test(file.text))
    .map((file) => file.label);
  assert.deepEqual(barrels, [], `barrel module(s): ${barrels.join(", ")}`);
});

/**
 * Empty `catch {}` blocks in `src/`, as measured. The target is zero; this is a
 * ratchet on the way there, and it is `<=` so the number only falls.
 *
 * It moved here from `test/ci-policy.test.mjs`, which walked this same tree
 * with a second copy of the walker and carried a ceiling of 32 against an
 * actual count of 28 -- four free slots for new ones.
 */
const EMPTY_CATCH_CEILING = 0;

test(`empty catch blocks in src/ never exceed ${EMPTY_CATCH_CEILING}`, () => {
  const offenders = SRC_FILES
    .map((file) => ({ label: file.label, count: (file.text.match(/catch\s*\{\s*\}/gu) ?? []).length }))
    .filter((file) => file.count > 0)
    .sort((left, right) => right.count - left.count);
  const total = offenders.reduce((sum, file) => sum + file.count, 0);
  assert.ok(
    total <= EMPTY_CATCH_CEILING,
    `${total} empty catch block(s), ceiling ${EMPTY_CATCH_CEILING}:\n` +
      offenders.map((f) => `  ${f.count}  ${f.label}`).join("\n"),
  );
  assert.equal(
    total,
    EMPTY_CATCH_CEILING,
    `the count fell to ${total}; lower EMPTY_CATCH_CEILING to match so it cannot drift back up.`,
  );
});

/**
 * Modules with no leading block comment, ratcheted down. `AGENTS.md` asks a
 * header to say what the module owns and *why it is separate* -- the reader can
 * see what the functions do. 30 of 84 predate the rule; the number only falls.
 */
const HEADERLESS_CEILING = 30;

test(`src/ modules without a header never exceed ${HEADERLESS_CEILING}`, () => {
  const headerless = SRC_FILES.filter((file) => !file.text.startsWith("/**")).map((file) => file.label);
  assert.ok(
    headerless.length <= HEADERLESS_CEILING,
    `${headerless.length} module(s) with no header, ceiling ${HEADERLESS_CEILING}:\n` +
      headerless.map((label) => `  ${label}`).join("\n"),
  );
  assert.equal(
    headerless.length,
    HEADERLESS_CEILING,
    `the count fell to ${headerless.length}; lower HEADERLESS_CEILING to match so it cannot drift back up.`,
  );
});
