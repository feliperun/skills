import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  let packet = node.taskPacket;
  if (fromFile) {
    const path = resolve(contractDir, node.taskPacketFile);
    try {
      packet = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw new TypeError(`nodes[${index}].taskPacketFile does not exist: ${path}`);
      if (error instanceof SyntaxError) throw new TypeError(`nodes[${index}].taskPacketFile is not valid JSON: ${error.message}`);
      throw error;
    }
  }
  validateTaskPacket(packet, index, cwd);
  return packet;
}

export function renderWorkerPrompt(packet, nodeId) {
  if (packet.mode === "discovery") return renderDiscoveryPrompt(packet, nodeId);
  const lines = [
    `# Node ${nodeId}`,
    "",
    "## Objective",
    packet.objective,
    "",
    "## Closed context",
    "This execution context is closed. Inspect only the listed read files, edit only the listed write files, and do not perform repository-wide discovery. If a required file or fact is missing, stop without speculative edits and report `BLOCKED_CONTEXT: <missing file or fact>`.",
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
    ...packet.verification,
  ];
  return `${lines.join("\n")}\n`;
}

function validateTaskPacket(packet, index, cwd) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new TypeError(`nodes[${index}].taskPacket must be a JSON object`);
  }
  for (const field of Object.keys(packet)) {
    if (!FIELDS.has(field)) throw new TypeError(`nodes[${index}].taskPacket has unexpected field ${field}`);
  }
  for (const field of FIELDS) {
    if (packet[field] === undefined) throw new TypeError(`nodes[${index}].taskPacket.${field} is required`);
  }
  if (!new Set(["execution", "discovery"]).has(packet.mode)) {
    throw new TypeError(`nodes[${index}].taskPacket.mode must be execution or discovery`);
  }
  requireString(packet.objective, `nodes[${index}].taskPacket.objective`);
  requireStringArray(packet.instructions, `nodes[${index}].taskPacket.instructions`, true);
  requireStringArray(packet.readFiles, `nodes[${index}].taskPacket.readFiles`);
  requireStringArray(packet.writeFiles, `nodes[${index}].taskPacket.writeFiles`);
  requireStringArray(packet.symbols, `nodes[${index}].taskPacket.symbols`);
  requireStringArray(packet.decisions, `nodes[${index}].taskPacket.decisions`);
  requireStringArray(packet.nonGoals, `nodes[${index}].taskPacket.nonGoals`);
  requireStringArray(packet.verification, `nodes[${index}].taskPacket.verification`, true);

  if (packet.mode === "execution") {
    if (!packet.readFiles.length) {
      throw new TypeError(`nodes[${index}].taskPacket.readFiles must not be empty for an execution packet`);
    }
    if (!packet.writeFiles.length) {
      throw new TypeError(`nodes[${index}].taskPacket.writeFiles must not be empty for an execution packet`);
    }
  } else if (packet.writeFiles.length) {
    throw new TypeError(`nodes[${index}].taskPacket.writeFiles must be empty for a discovery packet`);
  }

  packet.readFiles.forEach((path, pathIndex) => {
    validateRelativePath(path, `nodes[${index}].taskPacket.readFiles[${pathIndex}]`, cwd, true);
  });
  packet.writeFiles.forEach((path, pathIndex) => {
    validateRelativePath(path, `nodes[${index}].taskPacket.writeFiles[${pathIndex}]`, cwd, false);
  });
}

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
    if (error.code === "ENOENT") throw new TypeError(`${label} is a broken symbolic link: ${path}`);
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
      if (error.code === "ENOENT" || error.code === "ENOTDIR") current = candidate;
      else throw error;
    }
  }
  return current;
}

function findExistingPath(path) {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathInside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function renderDiscoveryPrompt(packet, nodeId) {
  const closedContext = packet.readFiles.length
    ? "This discovery context is read-only and closed to the listed files. Inspect only the listed read files, do not edit the repository, and do not perform repository-wide exploration. Produce an execution task packet instead of implementing anything. If a required file or fact is missing, report `BLOCKED_CONTEXT: <missing file or fact>`."
    : "This discovery context is read-only and is the one exception to closed inspection: no read files were pre-supplied, so you may inspect the repository read-only only as needed to produce the required packet. Do not edit the repository. Produce an execution task packet instead of implementing anything. If a required file or fact cannot be established, report `BLOCKED_CONTEXT: <missing file or fact>`.";
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
    'Return one JSON task packet with mode "execution" and every required taskPacket field. Its readFiles and writeFiles must be non-empty and scoped to this repository.',
    "",
    "## Verification",
    ...packet.verification,
  ];
  return `${lines.join("\n")}\n`;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

function requireStringArray(value, label, nonEmpty = false) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (nonEmpty && !value.length) throw new TypeError(`${label} must not be empty`);
  for (const [index, item] of value.entries()) {
    requireString(item, `${label}[${index}]`);
  }
}

function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`);
}

function bulletOrNone(items) {
  return items.length ? items.map((item) => `- ${item}`) : ["- (none)"];
}
