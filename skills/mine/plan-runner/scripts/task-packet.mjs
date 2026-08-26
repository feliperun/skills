import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateVerificationCommands } from "./verification.mjs";

const FIELDS = new Set([
  "mode",
  "objective",
  "instructions",
  "readFiles",
  "writeFiles",
  "symbols",
  "decisions",
  "nonGoals",
  "verification",
]);
const PROMPT_MAX_BYTES = 64 * 1024;

/** @typedef {import("./verification.mjs").VerificationCommand} VerificationCommand */

/**
 * A closed task packet: the durable scope and instructions for one node.
 *
 * @typedef {{mode: "execution"|"discovery", objective: string, instructions: string[], readFiles: string[], writeFiles: string[], symbols: string[], decisions: string[], nonGoals: string[], verification: VerificationCommand[]}} TaskPacket
 */

/**
 * Node fields consumed by packet loading. Exactly one of `taskPacket` or
 * `taskPacketFile` must be present; `prompt` and `promptFile` are rejected.
 *
 * @typedef {{taskPacket?: TaskPacket, taskPacketFile?: string, prompt?: unknown, promptFile?: unknown}} TaskPacketNode
 */

/**
 * @param {TaskPacketNode} node
 * @param {string} contractDir
 * @param {string} cwd
 * @param {number} index
 * @returns {TaskPacket}
 */
export function loadTaskPacket(node, contractDir, cwd, index) {
  if (node.prompt !== undefined || node.promptFile !== undefined) {
    throw new TypeError(
      `nodes[${index}] must not use prompt or promptFile; provide exactly one of taskPacket or taskPacketFile`,
    );
  }
  const inline = node.taskPacket !== undefined && node.taskPacket !== null;
  const fromFile = typeof node.taskPacketFile === "string" && Boolean(node.taskPacketFile);
  if (inline === fromFile) {
    throw new TypeError(`nodes[${index}] needs exactly one of taskPacket or taskPacketFile`);
  }
  let packet = /** @type {TaskPacket|undefined} */ (node.taskPacket);
  if (fromFile) {
    const path = resolve(contractDir, /** @type {string} */ (node.taskPacketFile));
    try {
      packet = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new TypeError(`nodes[${index}].taskPacketFile does not exist: ${path}`);
      }
      if (error instanceof SyntaxError) throw new TypeError(`nodes[${index}].taskPacketFile is not valid JSON: ${error.message}`);
      throw error;
    }
  }
  return validateTaskPacket(packet, index, cwd);
}

/**
 * @param {TaskPacket} packet
 * @param {string} nodeId
 * @returns {string}
 */
export function renderWorkerPrompt(packet, nodeId) {
  if (packet.mode === "discovery") return renderDiscoveryPrompt(packet, nodeId);
  const lines = [
    `# Node ${nodeId}`,
    "",
    "## Objective",
    packet.objective,
    "",
    "## Closed context",
    "This execution context is closed. Inspect only the listed read files, edit only the listed write files, and do not perform repository-wide discovery. If required context is unavailable, return the blocked_context worker-result object below.",
    "",
    "## Instructions",
    ...numbered(packet.instructions),
    "",
    "## Read files",
    ...bulletOrNone(packet.readFiles),
    "",
    "## Write files",
    ...bulletOrNone(packet.writeFiles),
    "",
    "## Symbols",
    ...bulletOrNone(packet.symbols),
    "",
    "## Decisions already made",
    ...bulletOrNone(packet.decisions),
    "",
    "## Non-goals",
    ...bulletOrNone(packet.nonGoals),
    "",
    "## Verification",
    "Run each command yourself before reporting done. Keep command output bounded: pipe long output through `| tail -n 200` (or similar) and never paste full test or fuzz logs into your context or results.",
    ...packet.verification.map((command) => `- ${command.argv.join(" ")}`),
    "",
    "## Required output",
    'Return exactly one JSON object, with no markdown or prose: {"status":"done"|"blocked_context","summary":"string","changedFiles":["string"],"verification":["string"],"artifacts":["string"],"missingContext":["string"]}. Use blocked_context only when missingContext is non-empty; use done only when missingContext is empty.',
  ];
  const prompt = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_MAX_BYTES) {
    throw new TypeError(`worker prompt exceeds ${PROMPT_MAX_BYTES} bytes`);
  }
  return prompt;
}

/**
 * @param {unknown} packet
 * @param {number} index
 * @param {string} cwd
 * @returns {TaskPacket}
 */
export function validateTaskPacket(packet, index, cwd) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new TypeError(`nodes[${index}].taskPacket must be a JSON object`);
  }
  const record = /** @type {Record<string, unknown>} */ (packet);
  for (const field of Object.keys(record)) {
    if (!FIELDS.has(field)) throw new TypeError(`nodes[${index}].taskPacket has unexpected field ${field}`);
  }
  for (const field of FIELDS) {
    if (record[field] === undefined) throw new TypeError(`nodes[${index}].taskPacket.${field} is required`);
  }
  const mode = record.mode;
  if (mode !== "execution" && mode !== "discovery") {
    throw new TypeError(`nodes[${index}].taskPacket.mode must be execution or discovery`);
  }
  requireString(record.objective, `nodes[${index}].taskPacket.objective`);
  requireStringArray(record.instructions, `nodes[${index}].taskPacket.instructions`, true);
  requireStringArray(record.readFiles, `nodes[${index}].taskPacket.readFiles`);
  requireStringArray(record.writeFiles, `nodes[${index}].taskPacket.writeFiles`);
  requireStringArray(record.symbols, `nodes[${index}].taskPacket.symbols`);
  requireStringArray(record.decisions, `nodes[${index}].taskPacket.decisions`);
  requireStringArray(record.nonGoals, `nodes[${index}].taskPacket.nonGoals`);
  if (!Array.isArray(record.verification)) {
    throw new TypeError(`nodes[${index}].taskPacket.verification must be an array of argv command objects`);
  }
  const verification = validateVerificationCommands(record.verification, `nodes[${index}].taskPacket.verification`);
  const readFiles = /** @type {string[]} */ (record.readFiles);
  const writeFiles = /** @type {string[]} */ (record.writeFiles);

  if (mode === "execution") {
    if (!readFiles.length) {
      throw new TypeError(`nodes[${index}].taskPacket.readFiles must not be empty for an execution packet`);
    }
    if (!writeFiles.length) {
      throw new TypeError(`nodes[${index}].taskPacket.writeFiles must not be empty for an execution packet`);
    }
  } else if (writeFiles.length) {
    throw new TypeError(`nodes[${index}].taskPacket.writeFiles must be empty for a discovery packet`);
  }

  readFiles.forEach((path, pathIndex) => {
    validateRelativePath(path, `nodes[${index}].taskPacket.readFiles[${pathIndex}]`, cwd, true);
  });
  writeFiles.forEach((path, pathIndex) => {
    validateRelativePath(path, `nodes[${index}].taskPacket.writeFiles[${pathIndex}]`, cwd, false);
  });
  for (const [commandIndex, command] of verification.entries()) {
    if (command.cwd !== undefined) {
      validateDirectoryPath(command.cwd, `nodes[${index}].taskPacket.verification[${commandIndex}].cwd`, cwd);
    }
  }
  return {
    mode,
    objective: /** @type {string} */ (record.objective),
    instructions: [.../** @type {string[]} */ (record.instructions)],
    readFiles,
    writeFiles,
    symbols: [.../** @type {string[]} */ (record.symbols)],
    decisions: [.../** @type {string[]} */ (record.decisions)],
    nonGoals: [.../** @type {string[]} */ (record.nonGoals)],
    verification,
  };
}

/**
 * @param {string} path
 * @param {string} label
 * @param {string} cwd
 * @param {boolean} mustExist
 */
function validateRelativePath(path, label, cwd, mustExist) {
  if (isAbsolute(path)) throw new TypeError(`${label} must be relative to cwd`);
  const absolute = resolve(cwd, path);
  if (!pathInside(absolute, cwd)) throw new TypeError(`${label} escapes cwd`);

  const realCwd = realpathSync(cwd);
  const actual = resolveActualPath(realCwd, path);
  if (!pathInside(actual, realCwd)) throw new TypeError(`${label} escapes cwd`);

  const anchor = findExistingPath(absolute);
  if (!anchor) throw new TypeError(`${label} escapes cwd`);
  let realAnchor;
  try {
    realAnchor = realpathSync(anchor);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new TypeError(`${label} is a broken symbolic link: ${path}`);
    throw error;
  }
  if (!pathInside(realAnchor, realCwd)) throw new TypeError(`${label} escapes cwd`);

  if (!mustExist && !existsSync(absolute)) return;
  if (!existsSync(absolute)) throw new TypeError(`${label} does not exist: ${path}`);
  const realAbsolute = realpathSync(absolute);
  if (!pathInside(realAbsolute, realCwd)) throw new TypeError(`${label} escapes cwd`);
  if (!statSync(absolute).isFile()) {
    throw new TypeError(`${label} ${mustExist ? "is not" : "must name"} a file: ${path}`);
  }
}

/**
 * @param {string} path
 * @param {string} label
 * @param {string} cwd
 */
function validateDirectoryPath(path, label, cwd) {
  if (isAbsolute(path)) throw new TypeError(`${label} must be relative to cwd`);
  const absolute = resolve(cwd, path);
  if (!pathInside(absolute, cwd)) throw new TypeError(`${label} escapes cwd`);
  const realCwd = realpathSync(cwd);
  const actual = resolveActualPath(realCwd, path);
  if (!pathInside(actual, realCwd) || !existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new TypeError(`${label} must name a directory inside cwd`);
  }
  if (!pathInside(realpathSync(absolute), realCwd)) throw new TypeError(`${label} escapes cwd`);
}

/**
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function resolveActualPath(root, path) {
  const segments = path.split(/[\\/]+/u).filter((segment) => segment && segment !== ".");
  let current = root;
  for (const segment of segments) {
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = `${current}${sep}${segment}`;
    try {
      current = realpathSync(candidate);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") current = candidate;
      else throw error;
    }
  }
  return current;
}

/**
 * @param {string} path
 * @returns {string|null}
 */
function findExistingPath(path) {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function pathInside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * @param {TaskPacket} packet
 * @param {string} nodeId
 * @returns {string}
 */
function renderDiscoveryPrompt(packet, nodeId) {
  const closedContext = packet.readFiles.length
    ? "This discovery context is read-only and closed to the listed read files. Inspect only those files and do not perform repository-wide exploration. Return the worker-result JSON object below; put exactly one execution task packet JSON string in artifacts[0]."
    : "This discovery context is read-only and is the one exception to closed inspection: no read files were pre-supplied, so you may inspect the repository read-only only as needed to produce the packet. Do not edit the repository. Return the worker-result JSON object below; put exactly one execution task packet JSON string in artifacts[0].";
  const lines = [
    `# Node ${nodeId} (discovery)`,
    "",
    "## Objective",
    packet.objective,
    "",
    "## Closed context",
    closedContext,
    "",
    "## Instructions",
    ...numbered(packet.instructions),
    "",
    "## Read files",
    ...bulletOrNone(packet.readFiles),
    "",
    "## Write files",
    "- (none: discovery is read-only)",
    "",
    "## Symbols",
    ...bulletOrNone(packet.symbols),
    "",
    "## Decisions already made",
    ...bulletOrNone(packet.decisions),
    "",
    "## Non-goals",
    ...bulletOrNone(packet.nonGoals),
    "",
    "## Required output",
    'Return exactly one worker-result JSON object, with no markdown or prose. Set status to "done", missingContext to [], and artifacts to an array containing exactly one JSON-stringified execution task packet with every required taskPacket field. The packet readFiles and writeFiles must be non-empty and scoped to this repository.',
    "",
    "## Verification",
    ...packet.verification.map((command) => `- ${command.argv.join(" ")}`),
  ];
  const prompt = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_MAX_BYTES) throw new TypeError(`worker prompt exceeds ${PROMPT_MAX_BYTES} bytes`);
  return prompt;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {boolean} nonEmpty
 */
function requireStringArray(value, label, nonEmpty = false) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (nonEmpty && !value.length) throw new TypeError(`${label} must not be empty`);
  for (const [index, item] of value.entries()) {
    requireString(item, `${label}[${index}]`);
  }
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`);
}

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function bulletOrNone(items) {
  return items.length ? items.map((item) => `- ${item}`) : ["- (none)"];
}

/** @param {unknown} error @returns {string|undefined} */
function errorCode(error) {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
