/**
 * Presentation of a metrics projection (TECH-SPEC section 8.4).
 *
 * `metrics.mjs` measures a campaign; this module is the only place that
 * decides how a measurement is printed. Both forms render the whole indicator
 * set and nothing else: effectiveness (`firstPassGateRate`, `ambientCoverage`)
 * is never printable without the efficiency it was bought with
 * (`weightedPerClosedCheckpoint`, `takesPerClosedCheckpoint`).
 *
 * The report is bounded by construction — one header line plus one line per
 * indicator, with grouped values elided past `MAX_GROUPS` — so a campaign with
 * many lanes prints in the same space as one with few. The dependency runs one
 * way: the projector imports the renderers, and nothing here reads a
 * filesystem path or a projection's inputs.
 */

/** @typedef {import("./metrics.mjs").CampaignMetrics} CampaignMetrics */
/** @typedef {import("./metrics.mjs").MetricsSources} MetricsSources */

/** Schema of the `--json` form; bumped when a consumer would have to change. */
const METRICS_SCHEMA_VERSION = 1;
/** Indicators whose value is a duration in seconds; the rest are ratios, counts or tokens. */
const SECONDS_INDICATORS = new Set([
  "wallClockPerClosedCheckpoint",
  "heartbeatStalenessP95",
  "budgetDecisionAge",
  "budgetAttentionLatencyP95",
  "notifyLatencyP95",
]);
/** Indicators whose value is a token total. */
const TOKEN_INDICATORS = new Set(["weightedPerClosedCheckpoint", "sessionContextGrowth", "workerPreambleTokens"]);
/** Groups printed per grouped indicator before the line is elided; the report stays bounded. */
const MAX_GROUPS = 6;
const NAME_WIDTH = 28;
const SECONDS_PER_HOUR = 3600;
/** Hours print at the four decimals the projector rounds its own values to. */
const HOURS_PRECISION = 10_000;

/**
 * The bounded human report: one line per indicator, always the full set, so
 * effectiveness is never read without the efficiency it was bought with.
 *
 * @param {MetricsSources} sources
 * @param {CampaignMetrics} metrics
 * @returns {string}
 */
export function renderMetricsReport(sources, metrics) {
  const repairs = sources.repairRunIds.length;
  const lines = [
    `[metrics] ${sources.campaignId} · ${sources.runIds.length} runs (${sources.takeRunIds.length} takes, ` +
      `${repairs} ${repairs === 1 ? "repair" : "repairs"}) · ${sources.events.length} events · ${Object.keys(metrics).length} indicators`,
  ];
  for (const [name, indicator] of Object.entries(metrics)) {
    const records = indicator.count === 1 ? "1 record" : `${indicator.count} records`;
    lines.push(`${name.padEnd(NAME_WIDTH)} ${indicator.direction.padEnd(11)} ${formatValue(name, indicator.value).padEnd(24)} · ${records}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The machine-readable form, one JSON line like `preflight --json`.
 *
 * @param {MetricsSources} sources
 * @param {CampaignMetrics} metrics
 * @returns {string}
 */
export function renderMetricsJson(sources, metrics) {
  return `${JSON.stringify({
    schemaVersion: METRICS_SCHEMA_VERSION,
    campaignId: sources.campaignId,
    runs: sources.runIds.length,
    takes: sources.takeRunIds.length,
    repairs: sources.repairRunIds.length,
    events: sources.events.length,
    indicators: metrics,
  })}\n`;
}

/**
 * @param {string} name
 * @param {number|Record<string, number>|null} value
 * @returns {string}
 */
function formatValue(name, value) {
  if (value === null) return "no record";
  if (typeof value === "number") {
    if (SECONDS_INDICATORS.has(name)) return formatSeconds(value);
    return TOKEN_INDICATORS.has(name) ? `${value} tokens` : String(value);
  }
  const groups = Object.entries(value);
  const shown = groups.slice(0, MAX_GROUPS).map(([group, measurement]) => `${group}=${measurement}`);
  if (groups.length > shown.length) shown.push(`+${groups.length - shown.length} more`);
  return shown.join(" ");
}

/** @param {number} seconds @returns {string} */
function formatSeconds(seconds) {
  const hours = seconds / SECONDS_PER_HOUR;
  return hours >= 1 ? `${seconds}s (${Math.round(hours * HOURS_PRECISION) / HOURS_PRECISION}h)` : `${seconds}s`;
}
