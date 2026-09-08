/**
 * The measured half of the release-1 indicator set (TECH-SPEC section 8.4),
 * extracted from `metrics.mjs` so the projector there stays the assembly of
 * indicators and this module stays what each one is measured from.
 *
 * Three measurements live here, plus the small numeric helpers they share:
 *
 * - `workerPreambleTokens`, the per-runtime harness preamble. Its source is
 *   `preflight --json`, which sends one trivial prompt through every routed
 *   runtime from an empty repository under exactly the flags a run uses and
 *   reports the resulting `usage.inputTokens` per check (TECH-SPEC 0.2 and
 *   rule 14). That is a measurement of the harness, not a recorded guess.
 * - the control-session cost of the notification outbox, which the pull-only
 *   contract keeps at whatever the `requiresUser` records alone cost.
 * - the liveness series behind heartbeat staleness and ambient coverage.
 */

/** Per-run evidence file holding one recorded `preflight --json` payload. */
export const PREFLIGHT_FILE = "preflight.json";

const LIVENESS_TYPE = "liveness";

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * Mean measured preamble tokens per runtime. A live `preflight --json` check
 * is the measurement: its `usage.inputTokens` is what the harness costs before
 * the packet, per runtime, under the run's own flags.
 *
 * @param {unknown[]} [preflight] recorded `preflight --json` payloads
 * @returns {{value: Record<string, number>, count: number}}
 */
export function preambleTokensByRuntime(preflight = []) {
  const measured = preflightPreambleTallies(preflight);
  /** @type {Map<string, {total: number, samples: number}>} */
  const runtimes = new Map(measured);
  /** @type {Record<string, number>} */
  const value = {};
  let count = 0;
  for (const runtime of [...runtimes.keys()].sort()) {
    const tally = /** @type {{total: number, samples: number}} */ (runtimes.get(runtime));
    value[runtime] = round4(tally.total / tally.samples);
    count += tally.samples;
  }
  return { value, count };
}

/**
 * Preamble tallies from the recorded preflight payloads. Only a live check
 * carries a measurement: a `--static` check never ran the probe, so it reports
 * no usage and contributes nothing rather than a preamble of zero.
 *
 * @param {unknown[]} payloads
 * @returns {Map<string, {total: number, samples: number}>}
 */
function preflightPreambleTallies(payloads) {
  /** @type {Map<string, {total: number, samples: number}>} */
  const runtimes = new Map();
  for (const raw of payloads) {
    const payload = jsonObjectOf(raw);
    if (payload === null || !Array.isArray(payload.checks)) continue;
    for (const entry of payload.checks) {
      const check = jsonObjectOf(entry);
      if (check === null || check.live !== true || typeof check.id !== "string" || check.id === "") continue;
      const usage = jsonObjectOf(check.usage);
      const tokens = usage === null ? undefined : usage.inputTokens;
      if (typeof tokens !== "number" || !Number.isFinite(tokens)) continue;
      const tally = runtimes.get(check.id) ?? { total: 0, samples: 0 };
      tally.total += tokens;
      tally.samples += 1;
      runtimes.set(check.id, tally);
    }
  }
  return runtimes;
}

/**
 * Control-session cost of the campaign, measured over the recorded
 * `notify.jsonl` receipts. Only `node.terminal`, `run.terminal` and
 * `attention` events are ever notified (progress never is), so every logical
 * event — its first attempt, `attempt: 1` — is a session wake; tokens are
 * estimated from that first receipt's own bytes. Latency is the delay from
 * that first attempt to whichever later receipt for the same event first
 * reports `delivered`, so a bounded retry's backoff shows up as latency
 * rather than disappearing.
 *
 * @param {unknown[]} notifications
 * @param {{bytes: number, tokens: number}} estimate
 * @returns {{count: number, wakes: number, tokens: number, latencies: number[]}}
 */
export function notifyUsageOf(notifications, estimate) {
  let count = 0;
  let wakes = 0;
  let tokens = 0;
  /** @type {number[]} */
  const latencies = [];
  /** @type {Map<string, number>} */
  const enqueuedAtByEvent = new Map();
  for (const raw of notifications) {
    const record = jsonObjectOf(raw);
    if (record === null) continue;
    count += 1;
    const key = `${record.type}:${record.runId ?? ""}:${record.nodeId ?? ""}`;
    if (record.attempt === 1) {
      wakes += 1;
      tokens += estimatedTokens(Buffer.byteLength(JSON.stringify(record), "utf8"), estimate);
      const atMs = timestampMs(record.at);
      if (Number.isFinite(atMs)) enqueuedAtByEvent.set(key, atMs);
    }
    if (record.status === "delivered") {
      const atMs = timestampMs(record.at);
      const enqueuedMs = enqueuedAtByEvent.get(key);
      if (Number.isFinite(atMs) && Number.isFinite(enqueuedMs)) {
        const seconds = (atMs - /** @type {number} */ (enqueuedMs)) / 1000;
        if (seconds >= 0) latencies.push(seconds);
      }
    }
  }
  return { count, wakes, tokens, latencies };
}

/**
 * @param {number} bytes
 * @param {{bytes: number, tokens: number}} estimate
 * @returns {number}
 */
export function estimatedTokens(bytes, estimate) {
  if (!Number.isFinite(estimate.bytes) || estimate.bytes <= 0) return 0;
  return Math.ceil((bytes * estimate.tokens) / estimate.bytes);
}

/**
 * @param {unknown[]} journal
 * @returns {JsonObject[]}
 */
export function livenessFactsOf(journal) {
  /** @type {JsonObject[]} */
  const facts = [];
  for (const raw of journal) {
    const fact = jsonObjectOf(raw);
    if (fact !== null && fact.type === LIVENESS_TYPE) facts.push(fact);
  }
  return facts;
}

/**
 * Seconds between consecutive liveness facts: the heartbeat age a reader would
 * observe just before each refresh, and the raw material of both the staleness
 * percentile and the ambient coverage.
 *
 * @param {JsonObject[]} facts
 * @returns {number[]}
 */
export function livenessGapsOf(facts) {
  /** @type {number[]} */
  const stamps = [];
  for (const fact of facts) {
    const atMs = timestampMs(fact.at);
    if (Number.isFinite(atMs)) stamps.push(atMs);
  }
  stamps.sort((left, right) => left - right);
  /** @type {number[]} */
  const gaps = [];
  for (let index = 0; index + 1 < stamps.length; index += 1) gaps.push((stamps[index + 1] - stamps[index]) / 1000);
  return gaps;
}

/**
 * Fraction of the measured campaign time covered by a fresh heartbeat: each
 * gap contributes at most `freshSec` of coverage.
 *
 * @param {number[]} gaps
 * @param {number} freshSec
 * @returns {number|null}
 */
export function coverageOf(gaps, freshSec) {
  if (gaps.length === 0) return null;
  let total = 0;
  let covered = 0;
  for (const gap of gaps) {
    total += gap;
    covered += Math.min(gap, freshSec);
  }
  return total <= 0 ? 1 : covered / total;
}

/**
 * Nonterminal liveness facts, the records `silentStallRate` measures gaps
 * between. Fewer than two means the rate has no supporting record at all,
 * which is the null case rather than the hard-target zero.
 *
 * @param {JsonObject[]} facts
 * @returns {number}
 */
export function countNonterminalFacts(facts) {
  let count = 0;
  for (const fact of facts) {
    if (fact.state === "done" || fact.state === "failed") continue;
    if (Number.isFinite(timestampMs(fact.at))) count += 1;
  }
  return count < 2 ? 0 : count;
}



/**
 * Fraction of consecutive nonterminal liveness facts whose gap exceeded
 * `staleSec` that went uncovered. There is no attention mechanism left to
 * cover a gap (the campaign-level stall watchdog that used to enqueue one is
 * gone with the supervisor), so every qualifying gap now counts as silent:
 * the rate is 1 whenever at least one qualifying gap exists, else 0. Facts
 * come only from a legacy journal — nothing writes new ones — so this
 * measures old campaigns and reports no record for new ones.
 *
 * @param {JsonObject[]} facts
 * @param {number} staleSec
 * @returns {number}
 */
export function silentStallRateOf(facts, staleSec) {
  /** @type {number[]} */
  const stamps = [];
  for (const fact of facts) {
    if (fact.state === "done" || fact.state === "failed") continue;
    const atMs = timestampMs(fact.at);
    if (Number.isFinite(atMs)) stamps.push(atMs);
  }
  stamps.sort((left, right) => left - right);
  let gaps = 0;
  for (let index = 0; index + 1 < stamps.length; index += 1) {
    const gapSeconds = (stamps[index + 1] - stamps[index]) / 1000;
    if (gapSeconds > staleSec) gaps += 1;
  }
  return gaps === 0 ? 0 : 1;
}

/**
 * @param {number[]} values
 * @returns {number|null}
 */
export function percentile95(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1);
  return ordered[Math.max(0, rank)];
}

/**
 * @param {unknown} value
 * @returns {JsonObject|null}
 */
export function jsonObjectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {JsonObject} */ (value) : null;
}

/** @param {unknown} value @returns {number} */
export function timestampMs(value) {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** @param {number} value @returns {number} */
export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
