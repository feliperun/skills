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
 */

const SKILL_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(SKILL_DIR, "src");

/** No file in this skill may exceed this. A longer file is doing a second job. */
const LINE_CEILING = 800;

/**
 * The one runtime import cycle left in `src/`, allowed by name. `startJudge`
 * evaluates the deterministic gate and then either dispatches a judge or settles
 * the node, so dispatch and settlement meet inside one function; separating them
 * is a design change (return a decision, let the caller settle), not a move.
 *
 * This list shrinks to zero. It never grows.
 */
const ALLOWED_CYCLES = [["engine/lifecycle.mjs", "engine/review.mjs"]];

/**
 * @param {string} dir
 * @param {(path: string) => boolean} [keep]
 * @returns {string[]} absolute paths of every matching file below `dir`
 */
function walk(dir, keep = (path) => path.endsWith(".mjs")) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // fixtures are recorded data, and golden tasks are historical record
      if (entry.name === "fixtures" || entry.name === "golden" || entry.name === "node_modules") continue;
      found.push(...walk(path, keep));
    } else if (entry.isFile() && keep(path)) {
      found.push(path);
    }
  }
  return found;
}

/** @param {string} path @returns {string} the path as `AGENTS.md` would name it */
function label(path) {
  return relative(SKILL_DIR, path).split(sep).join("/");
}

test(`no file in the skill exceeds ${LINE_CEILING} lines`, () => {
  const oversized = walk(SKILL_DIR)
    .map((path) => ({ path: label(path), lines: readFileSync(path, "utf8").split("\n").length }))
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
 * Runtime import edges only. A JSDoc `import("./x.mjs").Type` is a type
 * reference erased before the module ever loads, and counting those reports
 * cycles that do not exist -- as an earlier version of this analysis did.
 *
 * @returns {Map<string, Set<string>>}
 */
function runtimeImportGraph() {
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  for (const path of walk(SRC_DIR)) {
    const source = readFileSync(path, "utf8")
      .replace(/\/\*(?:[^*]|\*(?!\/))*\*\//gu, " ")
      .replace(/\/\/[^\n]*/gu, " ");
    /** @type {Set<string>} */
    const edges = new Set();
    for (const match of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*"(\.[^"]+)"/gsu)) {
      edges.add(match[1]);
    }
    for (const match of source.matchAll(/\bimport\s*"(\.[^"]+)"/gu)) edges.add(match[1]);
    graph.set(
      relative(SRC_DIR, path).split(sep).join("/"),
      new Set([...edges].map((spec) => relative(SRC_DIR, join(path, "..", spec)).split(sep).join("/"))),
    );
  }
  return graph;
}

test("src/ has no runtime import cycle beyond the ones allowed by name", () => {
  const graph = runtimeImportGraph();
  /** @type {Set<string>} */
  const cycles = new Set();
  /** @param {string} node @param {string[]} stack @param {Set<string>} seen */
  const visit = (node, stack, seen) => {
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (stack.includes(next)) {
        cycles.add([...new Set(stack.slice(stack.indexOf(next)))].sort().join(" <-> "));
      } else if (!seen.has(next)) {
        seen.add(next);
        visit(next, [...stack, next], seen);
      }
    }
  };
  for (const node of graph.keys()) visit(node, [node], new Set([node]));

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
 * Every top-level definition in `src/`, with its module, whether it is exported,
 * and its body normalized for comparison.
 *
 * @returns {Map<string, {module: string, exported: boolean, body: string}[]>}
 */
function definitionsBySrcName() {
  /** @type {Map<string, {module: string, exported: boolean, body: string}[]>} */
  const byName = new Map();
  for (const path of walk(SRC_DIR)) {
    const module = relative(SRC_DIR, path).split(sep).join("/");
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const match = /^(export\s+)?(?:async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (!match) continue;
      let depth = 0;
      let end = index;
      for (let scan = index; scan < lines.length; scan += 1) {
        depth += (lines[scan].match(/\{/gu) ?? []).length - (lines[scan].match(/\}/gu) ?? []).length;
        end = scan;
        if (depth <= 0 && scan > index) break;
      }
      const body = lines.slice(index, end + 1).map((text) => text.trim()).join("\n").replace(/^export /u, "");
      byName.set(match[2], [...(byName.get(match[2]) ?? []), { module, exported: Boolean(match[1]), body }]);
    }
  }
  return byName;
}

test("no function body is defined twice in src/", () => {
  const duplicated = [];
  for (const [name, entries] of definitionsBySrcName()) {
    /** @type {Map<string, string[]>} */
    const byBody = new Map();
    for (const entry of entries) byBody.set(entry.body, [...(byBody.get(entry.body) ?? []), entry.module]);
    for (const modules of byBody.values()) {
      if (new Set(modules).size > 1) duplicated.push(`${name}: ${[...new Set(modules)].sort().join(", ")}`);
    }
  }
  assert.deepEqual(
    duplicated.sort(),
    [],
    `the same body in two modules:\n${duplicated.map((line) => `  ${line}`).join("\n")}\n` +
      "Give it one home and import it.",
  );
});

test("no name is exported from two src/ modules", () => {
  // A module-private helper may share a name with another module's -- a
  // standalone spawned program having its own `fail` or `usage` is idiomatic and
  // nobody can import it by mistake. Two *exported* ones is the hazard: this
  // tree had two `stableJson`s (a comparator and a pretty-printer) and two
  // `requireText`s (one of which read a file).
  const collisions = [];
  for (const [name, entries] of definitionsBySrcName()) {
    const homes = [...new Set(entries.filter((entry) => entry.exported).map((entry) => entry.module))];
    if (homes.length > 1) collisions.push(`${name}: ${homes.sort().join(", ")}`);
  }
  assert.deepEqual(
    collisions.sort(),
    [],
    `one name exported from two modules:\n${collisions.map((line) => `  ${line}`).join("\n")}\n` +
      "Either they are the same function (give it one home) or they are not (rename one for what it does).",
  );
});

test("no src/ module is a barrel", () => {
  const barrels = [];
  for (const path of walk(SRC_DIR)) {
    const source = readFileSync(path, "utf8");
    const reExports = [...source.matchAll(/^export\s*\{[^}]*\}\s*from\s*"/gmu)].length;
    if (reExports === 0) continue;
    const ownDefinitions = [...source.matchAll(
      /^export\s+(?:async\s+function|function|const|let|class)\s/gmu,
    )].length;
    // A module that re-exports and defines nothing of its own is a barrel: it
    // gives every symbol it forwards a second home.
    if (ownDefinitions === 0) barrels.push(label(path));
  }
  assert.deepEqual(barrels, [], `barrel module(s): ${barrels.join(", ")}`);
});
