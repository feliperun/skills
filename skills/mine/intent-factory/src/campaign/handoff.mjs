/**
 * `HANDOFF.md`: the campaign's state rendered for the next session to read
 * first, inside a byte budget.
 *
 * The budget is the whole design. A handoff that grows without bound stops being
 * read, so sections compete: critical first with a guaranteed floor, then linked
 * runs, then the low-priority tail, each fitted line by line. What does not fit
 * is dropped visibly, never truncated mid-record.
 */
import { CRITICAL_FLOOR_BYTES, GOAL_TEXT_BYTES, HANDOFF_BYTES, HANDOFF_FILE, HANDOFF_LIMIT, ID_CAP_FLOOR, JOURNAL_TEXT_BYTES, RENDER_NOTE_BYTES } from "./layout.mjs";
import { basename, join } from "node:path";
import { boundedText } from "../util.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeTextAtomic } from "../run/store.mjs";

/** @typedef {import("./index.mjs").Campaign} Campaign */
/** @typedef {import("./index.mjs").Handoff} Handoff */
/** @typedef {import("./index.mjs").JournalEntry} JournalEntry */
/** @typedef {import("../notify/index.mjs").JsonObject} JsonObject */
/** @typedef {import("./index.mjs").Projection} Projection */
/** @typedef {import("./index.mjs").RunSummary} RunSummary */

/**
 * @param {Handoff} handoff
 * @returns {string}
 */
export function fitHandoff(handoff) {
  // The internal LineBudget already bounds every candidate to 16 KiB, so the
  // descending caps exist to shrink entry text until no critical entry is lost,
  // not to shrink the document. Return the first candidate with zero critical
  // loss; cap 0 always preserves at least a bare line per critical entry
  // because every rendered fragment, including identifiers, is bounded.
  for (const cap of [JOURNAL_TEXT_BYTES, 1024, 512, 256, 128, 64, 32, 0]) {
    const rendered = renderBudgeted(handoff, cap);
    if (rendered.criticalLost === 0) return rendered.text;
  }
  return renderBudgeted(handoff, 0).text;
}
/**
 * @param {Campaign} campaign
 * @param {Projection} state
 * @param {string} runsDir
 * @returns {Handoff}
 */
export function handoffFromState(campaign, state, runsDir) {
  return {
    campaign,
    updatedAt: state.updatedAt ?? campaign.updatedAt,
    linkedRuns: campaign.linkedRunIds.map((runId) => runSummary(join(runsDir, runId))),
    activeDecisions: Object.values(state.decisions),
    constraints: state.constraints,
    intents: lastN(state.intents),
    outcomes: lastN(state.outcomes),
    nextEntry: state.next,
    questions: Object.values(state.questions),
    sessions: state.sessions,
    totals: {
      decisions: Object.keys(state.decisions).length,
      constraints: state.constraints.length,
      intents: state.intents.length,
      outcomes: state.outcomes.length,
      questions: Object.keys(state.questions).length,
      sessions: state.sessions.length,
    },
    evicted: state.evicted,
  };
}
/**
 * @param {string} campaignPath
 * @param {Handoff} handoff
 * @returns {string}
 */
export function materializeHandoff(campaignPath, handoff) {
  const text = fitHandoff(handoff);
  writeTextAtomic(join(campaignPath, HANDOFF_FILE), text);
  return text;
}
/**
 * @param {Handoff} handoff
 * @param {number} cap
 * @returns {{text: string, criticalLost: number}}
 */
function renderBudgeted(handoff, cap) {
  const {
    campaign, linkedRuns, activeDecisions, constraints, intents, outcomes, nextEntry, questions, sessions,
    totals = { decisions: 0, constraints: 0, intents: 0, outcomes: 0, questions: 0, sessions: 0 },
    evicted = { sessions: 0, decisions: 0, constraints: 0, questions: 0, intents: 0, outcomes: 0 },
  } = handoff;
  // Identifiers and attention notes keep a floor so critical entries stay
  // recognizable even when the descending text caps reach zero.
  const noteCap = Math.max(Math.min(RENDER_NOTE_BYTES, cap), ID_CAP_FLOOR);
  const idCap = Math.max(cap, ID_CAP_FLOOR);
  const budget = new LineBudget(HANDOFF_BYTES);
  addSection(budget, [
    `# campaign ${boundedText(campaign.id, idCap)} handoff`,
    "",
    `Updated: ${handoff.updatedAt}`,
    "",
    "## Goal",
    "",
    boundedText(campaign.goal, GOAL_TEXT_BYTES),
    "",
  ]);
  // Each critical section reserves a floor for every section that still
  // follows, so one greedy section can never starve a later critical one
  // (including attention-needed linked runs); low-priority history takes
  // whatever remains.
  const attentionPresent = hasAttentionRuns(linkedRuns);
  let sectionsLeft = 5 + (attentionPresent ? 1 : 0);
  const nextSection = () => {
    const left = sectionsLeft;
    sectionsLeft -= 1;
    return left;
  };
  let criticalLost = 0;
  // Stamped like every other journal section: this is the entry most likely to
  // go stale, because it names a run that later runs supersede. Without the
  // timestamp a reader cannot tell it apart from the current frontier.
  criticalLost += criticalSection(budget, "Latest next action", nextEntry ? [nextEntry] : [], (entry) => entryLine(entry, idCap, cap), 0, nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Session lineage", sessions, (entry) => sessionLine(entry, idCap, cap), totals.sessions - sessions.length + (evicted.sessions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Active decisions", activeDecisions, (entry) => decisionLine(entry, idCap, cap), totals.decisions - activeDecisions.length + (evicted.decisions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "User constraints", constraints, (entry) => entryLine(entry, idCap, cap), totals.constraints - constraints.length + (evicted.constraints ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += criticalSection(budget, "Open questions", questions, (entry) => entryLine(entry, idCap, cap), totals.questions - questions.length + (evicted.questions ?? 0), nextSection(), CRITICAL_FLOOR_BYTES);
  criticalLost += renderLinkedRuns(budget, linkedRuns, noteCap, idCap, attentionPresent ? nextSection() : null, CRITICAL_FLOOR_BYTES);
  lowPriorityLines(budget, "Recent user intents", intents, (entry) => entryLine(entry, idCap, cap), totals.intents - intents.length + (evicted.intents ?? 0));
  lowPriorityLines(budget, "Attempts and outcomes", outcomes, (entry) => outcomeLine(entry, idCap, cap), totals.outcomes - outcomes.length + (evicted.outcomes ?? 0));
  return { text: `${budget.lines.join("\n")}\n`, criticalLost };
}
/**
 * @param {RunSummary[]} linkedRuns
 * @returns {boolean}
 */
function hasAttentionRuns(linkedRuns) {
  return linkedRuns.some((run) => !run.exists || run.unreadable || run.attention.length > 0);
}
/**
 * @param {LineBudget} budget
 * @param {string[]} lines
 * @returns {boolean}
 */
function addSection(budget, lines) {
  if (!lines.length) return true;
  let total = 0;
  for (const line of lines) total += Buffer.byteLength(line, "utf8") + 1;
  if (budget.used + total > budget.limit) return false;
  for (const line of lines) budget.add(line);
  return true;
}
// Critical sections must never be dropped wholesale: when the remaining budget
// cannot hold every entry, keep the latest entries that fit and note the rest.
// Returns 1 when a non-empty section loses every entry (nothing but the
// placeholder was rendered), 0 otherwise; a section that keeps its latest
// entries plus an omission note is considered preserved. The floor keeps later
// critical sections from being starved by earlier greedy ones.
/**
 * @param {LineBudget} budget
 * @param {string} title
 * @param {JournalEntry[]} entries
 * @param {(entry: JournalEntry) => string} lineFor
 * @param {number} omittedCount
 * @param {number} sectionsLeft
 * @param {number} floor
 * @returns {0|1}
 */
function criticalSection(budget, title, entries, lineFor, omittedCount, sectionsLeft, floor) {
  budget.add(`## ${title}`);
  budget.add("");
  if (!entries.length) {
    budget.add("None.");
    budget.add("");
    return 0;
  }
  const kept = budgetedLines(budget, entries.map((entry) => `- ${lineFor(entry)}`), title.toLowerCase(), omittedCount, criticalLimit(budget, sectionsLeft, floor));
  budget.add("");
  return kept === 0 ? 1 : 0;
}
/**
 * @param {LineBudget} budget
 * @param {number} sectionsLeft
 * @param {number} floor
 * @returns {number}
 */
function criticalLimit(budget, sectionsLeft, floor) {
  // An absolute byte ceiling: budgetedLines already compares against the used
  // budget, so the floor reservation must not subtract it a second time.
  return budget.limit - floor * Math.max(0, sectionsLeft - 1);
}
/**
 * @param {LineBudget} budget
 * @param {string} title
 * @param {JournalEntry[]} entries
 * @param {(entry: JournalEntry) => string} lineFor
 * @param {number} omittedCount
 */
function lowPriorityLines(budget, title, entries, lineFor, omittedCount) {
  if (!budget.addAll([`## ${title}`, ""])) return;
  if (!entries.length) {
    budget.addAll(["None.", ""]);
    return;
  }
  budgetedLines(budget, entries.map((entry) => `- ${lineFor(entry)}`), title.toLowerCase(), omittedCount);
  budget.add("");
}
// Keep the latest complete lines that fit; older lines are summarized, never
// silently dropped. Returns the number of entries actually rendered.
/**
 * @param {LineBudget} budget
 * @param {string[]} lines
 * @param {string} label
 * @param {number} omittedCount
 * @param {number} limit
 * @returns {number}
 */
function budgetedLines(budget, lines, label, omittedCount, limit = budget.limit) {
  let kept = 0;
  let projected = budget.used;
  while (kept < lines.length) {
    const bytes = Buffer.byteLength(lines[lines.length - 1 - kept], "utf8") + 1;
    if (projected + bytes > limit) break;
    projected += bytes;
    kept += 1;
  }
  const dropped = lines.length - kept + omittedCount;
  if (dropped > 0) {
    // Reserve room for the omission note so it is never silently dropped.
    while (kept > 0 && projected + Buffer.byteLength(`- ${dropped} earlier ${label} omitted`, "utf8") + 1 > limit) {
      kept -= 1;
      projected -= Buffer.byteLength(lines[lines.length - 1 - kept], "utf8") + 1;
    }
  }
  if (kept === 0) {
    budget.add(`- (none fits the remaining budget)`);
  } else {
    for (let index = lines.length - kept; index < lines.length; index += 1) budget.add(lines[index]);
  }
  if (dropped > 0) budget.add(`- ${dropped} earlier ${label} omitted`);
  return kept;
}
// Linked runs are critical when a run needs attention: losing the whole
// section or every line of an attention group counts as critical loss so the
// cap loop shrinks text until attention-needed states survive. A partially
// kept group (summary plus latest detail lines plus an omission note) is
// considered preserved, matching the other critical sections.
/**
 * @param {LineBudget} budget
 * @param {RunSummary[]} linkedRuns
 * @param {number} noteCap
 * @param {number} idCap
 * @param {number|null} sectionsLeft
 * @param {number} floor
 * @returns {0|1}
 */
function renderLinkedRuns(budget, linkedRuns, noteCap, idCap, sectionsLeft, floor) {
  const runs = buildRunsGroups(linkedRuns, noteCap, idCap);
  if (runs.empty) {
    addSection(budget, ["## Linked runs", "", "No linked runs yet.", ""]);
    return 0;
  }
  const limit = sectionsLeft === null || sectionsLeft === undefined ? budget.limit : criticalLimit(budget, sectionsLeft, floor);
  const headingFits = addSection(budget, ["## Linked runs", ""]);
  const attentionKept = headingFits ? budgetedGroupLines(budget, runs.attention, "attention-needed run states", limit) : 0;
  if (runs.attention.length && attentionKept === 0) return 1;
  if (headingFits) budgetedGroupLines(budget, runs.regular, "run summaries", limit);
  budget.add("");
  return 0;
}
// Runs are rendered as whole groups (summary line plus node detail lines) so a
// run is never cut midway. When a group does not fully fit, its summary line
// and the latest detail lines are kept and the rest is summarized. Returns the
// number of lines actually added to the budget.
/**
 * @param {LineBudget} budget
 * @param {string[][]} groups
 * @param {string} label
 * @param {number} limit
 * @returns {number}
 */
function budgetedGroupLines(budget, groups, label, limit = budget.limit) {
  const rendered = [];
  let projected = budget.used;
  let omitted = 0;
  let added = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const lines = groups[index];
    if (projected + totalLineBytes(lines) <= limit) {
      projected += totalLineBytes(lines);
      rendered.unshift(lines);
      added += lines.length;
      continue;
    }
    const kept = fitGroupLines(lines, projected, limit);
    if (kept.length) {
      projected += totalLineBytes(kept);
      rendered.unshift(kept);
      added += kept.length;
      omitted += lines.length - kept.length;
      continue;
    }
    omitted += lines.length;
    for (let older = index - 1; older >= 0; older -= 1) omitted += groups[older].length;
    break;
  }
  if (omitted > 0) {
    // Reserve room for the omission note so it is never silently dropped.
    while (rendered.length && projected + Buffer.byteLength(`- ${omitted} earlier ${label} omitted`, "utf8") + 1 > limit) {
      const lines = rendered.shift() ?? [];
      projected -= totalLineBytes(lines);
      added -= lines.length;
      omitted += lines.length;
    }
  }
  for (const lines of rendered) {
    for (const line of lines) budget.add(line);
  }
  if (omitted > 0) budget.add(`- ${omitted} earlier ${label} omitted`);
  return added;
}
/**
 * @param {string[]} lines
 * @param {number} projected
 * @param {number} limit
 * @returns {string[]}
 */
function fitGroupLines(lines, projected, limit) {
  const leadBytes = Buffer.byteLength(lines[0], "utf8") + 1;
  if (projected + leadBytes > limit) return [];
  const detail = [];
  projected += leadBytes;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (projected + bytes > limit) break;
    projected += bytes;
    detail.unshift(lines[index]);
  }
  return [lines[0], ...detail];
}
/**
 * @param {string[]} lines
 * @returns {number}
 */
function totalLineBytes(lines) {
  let bytes = 0;
  for (const line of lines) bytes += Buffer.byteLength(line, "utf8") + 1;
  return bytes;
}
/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function sessionLine(entry, idCap, textCap) {
  const tool = boundedText(entry.tool, idCap);
  const sessionId = boundedText(entry.sessionId, idCap);
  const transcript = entry.transcriptUnavailable ? "unavailable" : boundedText(entry.transcript, Math.max(idCap, 128));
  const format = boundedText(entry.format ?? "-", idCap);
  const cursor = boundedText(entry.cursor ?? "-", idCap);
  return `${tool} ${sessionId} · transcript: ${transcript} · format: ${format} · cursor: ${cursor}`;
}
/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function decisionLine(entry, idCap, textCap) {
  return `[${boundedText(entry.decisionId, idCap)}] ${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}
/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function entryLine(entry, idCap, textCap) {
  return `${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}
/**
 * @param {JournalEntry} entry
 * @param {number} idCap
 * @param {number} textCap
 * @returns {string}
 */
function outcomeLine(entry, idCap, textCap) {
  const run = entry.runId ? `run ${boundedText(entry.runId, idCap)}: ` : "";
  return `${run}${boundedText(entry.text, textCap)} · ${boundedText(entry.sessionId, idCap)} · ${boundedText(entry.at, idCap)}`;
}
/**
 * @param {RunSummary[]} linkedRuns
 * @param {number} noteCap
 * @param {number} idCap
 * @returns {{empty: boolean, attention: string[][], regular: string[][]}}
 */
function buildRunsGroups(linkedRuns, noteCap, idCap) {
  if (!linkedRuns.length) return { empty: true, attention: [], regular: [] };
  const attention = [];
  const regular = [];
  for (const run of linkedRuns) {
    const id = boundedText(run.id, idCap);
    if (!run.exists) {
      attention.push([`- ${id}: run directory missing`]);
      continue;
    }
    if (run.unreadable) {
      attention.push([`- ${id}: unreadable · ${boundedText(run.unreadable, noteCap)}`]);
      continue;
    }
    if (!run.total) {
      regular.push([`- ${id}: no node states yet`]);
      continue;
    }
    const lines = [`- ${id}: ${boundedText(run.summary, idCap)}`];
    if (run.attention.length) {
      for (const node of run.attention) {
        const nodeId = boundedText(node.id, idCap);
        const status = boundedText(node.status, idCap);
        lines.push(`  - ${nodeId}: ${status}${node.note ? ` · ${boundedText(node.note, noteCap)}` : ""}`);
      }
      attention.push(lines);
    } else {
      regular.push(lines);
    }
  }
  return { empty: false, attention, regular };
}
/**
 * @param {string} runDir
 * @returns {RunSummary}
 */
function runSummary(runDir) {
  const id = basename(runDir);
  const nodeDir = join(runDir, "nodes");
  if (!existsSync(nodeDir)) return { id, exists: false, total: 0, summary: "", attention: [], unreadable: null };
  let nodes;
  try {
    nodes = readdirSync(nodeDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => /** @type {JsonObject} */ (JSON.parse(readFileSync(join(nodeDir, name), "utf8"))));
  } catch (error) {
    return { id, exists: true, total: 0, summary: "unreadable", attention: [], unreadable: `cannot read node states: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!nodes.length) return { id, exists: true, total: 0, summary: "no node states yet", attention: [], unreadable: null };
  const counts = new Map();
  for (const node of nodes) counts.set(/** @type {string} */ (node.status), (counts.get(/** @type {string} */ (node.status)) ?? 0) + 1);
  const summary = `${nodes.length} nodes · ${[...counts].map(([status, count]) => `${count} ${status}`).join(" · ")}`;
  const attention = nodes
    .filter((node) => !["pending", "running", "done"].includes(/** @type {string} */ (node.status)))
    .map((node) => {
      const gate = /** @type {JsonObject|null|undefined} */ (node.gate);
      const error = /** @type {JsonObject|null|undefined} */ (node.error);
      const blockedBy = /** @type {unknown[]|undefined} */ (node.blockedBy);
      const note = typeof gate?.summary === "string" ? gate.summary
        : typeof error?.message === "string" ? error.message
          : blockedBy?.length ? `blocked by ${blockedBy.join(", ")}`
            : typeof node.phase === "string" ? node.phase : "";
      return {
        id: /** @type {string} */ (node.id),
        status: /** @type {string} */ (node.status),
        note,
      };
    });
  return { id, exists: true, total: nodes.length, summary, attention, unreadable: null };
}
class LineBudget {
  /**
   * @param {number} limit
   */
  constructor(limit) {
    /** @type {number} */
    this.limit = limit;
    /** @type {number} */
    this.used = 0;
    /** @type {string[]} */
    this.lines = [];
  }

  /**
   * @param {string} line
   * @returns {boolean}
   */
  fits(line) {
    return this.used + Buffer.byteLength(line, "utf8") + 1 <= this.limit;
  }

  /**
   * @param {string} line
   * @returns {boolean}
   */
  add(line) {
    if (!this.fits(line)) return false;
    this.lines.push(line);
    this.used += Buffer.byteLength(line, "utf8") + 1;
    return true;
  }

  /**
   * @param {string[]} lines
   * @returns {number}
   */
  addAll(lines) {
    let added = 0;
    for (const line of lines) {
      if (!this.add(line)) break;
      added += 1;
    }
    return added;
  }
}
/**
 * @param {JournalEntry[]} entries
 * @returns {JournalEntry[]}
 */
function lastN(entries) {
  return entries.slice(-HANDOFF_LIMIT);
}
