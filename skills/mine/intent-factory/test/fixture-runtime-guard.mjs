const REPORTED_DRIVERS = new Set(["codex", "claude", "agy", "dsh", "zcode"]);
const EXEMPTION_MARKER = "guard-exempt: schema-only";

/**
 * Build a same-length mask marking which characters of `text` sit outside any
 * string or comment literal, so brace/comma scanning never trips on `{`, `}`,
 * or `,` quoted inside a model name or a comment.
 *
 * @param {string} text
 * @returns {boolean[]}
 */
function structuralMask(text) {
  const mask = new Array(text.length).fill(true);
  /** @type {null|'"'|"'"|'`'|'//'|'/*'} */
  let state = null;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === '"' || state === "'" || state === "`") {
      mask[index] = false;
      if (char === "\\") { mask[index + 1] = false; index += 2; continue; }
      if (char === state) state = null;
      index += 1;
      continue;
    }
    if (state === "//") {
      mask[index] = false;
      if (char === "\n") state = null;
      index += 1;
      continue;
    }
    if (state === "/*") {
      mask[index] = false;
      if (char === "*" && next === "/") { mask[index + 1] = false; state = null; index += 2; continue; }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { state = /** @type {'"'|"'"|'`'} */ (char); mask[index] = false; index += 1; continue; }
    if (char === "/" && next === "/") { state = "//"; mask[index] = false; index += 1; continue; }
    if (char === "/" && next === "*") { state = "/*"; mask[index] = false; index += 1; continue; }
    index += 1;
  }
  return mask;
}

/**
 * @param {string} text
 * @param {number} openIndex index of the opening `{`
 * @param {boolean[]} mask
 * @returns {number} index of the matching `}`, or -1
 */
function findMatchingBrace(text, openIndex, mask) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (!mask[index]) continue;
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Split `text` on its top-level commas, treating nested `{}`, `[]`, and `()`
 * as opaque so a runtime's own `config: { ... }` never fractures its entry.
 *
 * @param {string} text
 * @param {boolean[]} mask
 * @returns {string[]}
 */
function splitTopLevelEntries(text, mask) {
  const entries = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!mask[index]) continue;
    const char = text[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(text.slice(start));
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Drop leading whitespace and `//`/`/* *\/` comments so a marker or note
 * placed above a runtime's key does not stop the key from being found.
 *
 * @param {string} text
 * @returns {string}
 */
function stripLeadingTrivia(text) {
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { index += whitespace[0].length; continue; }
    if (rest.startsWith("//")) {
      const newlineIndex = rest.indexOf("\n");
      index += newlineIndex === -1 ? rest.length : newlineIndex + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const endIndex = rest.indexOf("*/");
      index += endIndex === -1 ? rest.length : endIndex + 2;
      continue;
    }
    break;
  }
  return text.slice(index);
}

/**
 * @param {string} entryText
 * @returns {{runtimeId: string, driver: string|null, hasExecutable: boolean, exempt: boolean}|null}
 */
function parseRuntimeEntry(entryText) {
  const keyMatch = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(stripLeadingTrivia(entryText));
  if (!keyMatch) return null;
  const runtimeId = /** @type {string} */ (keyMatch[1] ?? keyMatch[2] ?? keyMatch[3]);
  const driverMatch = /\bdriver\s*:\s*["']([^"']+)["']/.exec(entryText);
  return {
    runtimeId,
    driver: driverMatch ? driverMatch[1] : null,
    // Matches both `executable: value` and the ES2015 shorthand `{ executable }`.
    hasExecutable: /\bexecutable\b/.test(entryText),
    exempt: entryText.includes(EXEMPTION_MARKER),
  };
}

/**
 * Scan a test file's source for `runtimes: { ... }` fixture blocks and report
 * every entry whose driver would resolve a real provider CLI (codex, claude,
 * agy, dsh, zcode) but declares no `executable`, since env-preflight then
 * falls back to whatever binary of that name is first on PATH.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {{fileName: string, runtimeId: string, driver: string}[]}
 */
export function runtimesMissingExecutable(source, fileName) {
  const findings = [];
  const sourceMask = structuralMask(source);
  const runtimesBlock = /runtimes\s*:\s*\{/g;
  let match;
  while ((match = runtimesBlock.exec(source))) {
    const openBraceIndex = match.index + match[0].length - 1;
    if (!sourceMask[openBraceIndex]) continue;
    const closeBraceIndex = findMatchingBrace(source, openBraceIndex, sourceMask);
    if (closeBraceIndex === -1) continue;
    const blockContent = source.slice(openBraceIndex + 1, closeBraceIndex);
    const blockMask = sourceMask.slice(openBraceIndex + 1, closeBraceIndex);
    for (const entryText of splitTopLevelEntries(blockContent, blockMask)) {
      const entry = parseRuntimeEntry(entryText);
      if (!entry || !entry.driver) continue;
      if (!REPORTED_DRIVERS.has(entry.driver)) continue;
      if (entry.hasExecutable || entry.exempt) continue;
      findings.push({ fileName, runtimeId: entry.runtimeId, driver: entry.driver });
    }
  }
  return findings;
}
