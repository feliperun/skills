/**
 * Presentation of a metrics projection (TECH-SPEC lean section 6).
 *
 * `metrics.mjs` measures a campaign; this module is the only place that
 * decides how a measurement is printed. Both forms render the whole indicator
 * set and nothing else.
 *
 * The report is bounded by construction — one header line plus one line per
 * indicator, with grouped values elided past `MAX_GROUPS` — so a campaign with
 * many lanes or runtimes prints in the same space as one with few. The
 * dependency runs one way: the projector imports the renderers, and nothing
 * here reads a filesystem path or a projection's inputs.
 */

/** @typedef {import("../campaign/metrics.mjs").CampaignMetrics} CampaignMetrics */
/** @typedef {import("../campaign/metrics.mjs").MetricsSources} MetricsSources */

/** Schema of the `--json` form; bumped when a consumer would have to change. */
const METRICS_SCHEMA_VERSION = 2;
/** Indicators whose value is a duration in seconds; the rest are ratios, counts or tokens. */
const SECONDS_INDICATORS = new Set(["wallClockSec"]);
/** Groups printed per grouped indicator before the line is elided; the report stays bounded. */
const MAX_GROUPS = 6;
/** The runtime-by-kind breakdown doubles the key length of every other grouped indicator, so it elides sooner. */
/** @type {Record<string, number>} */
const MAX_GROUPS_BY_INDICATOR = { usageTokensByKindByRuntime: 2 };
/** Large token counts compact to a short suffix in the two token indicators; every other grouped value prints as-is. */
const COMPACT_TOKEN_INDICATORS = new Set(["usageTokensByKind", "usageTokensByKindByRuntime"]);
const NAME_WIDTH = 28;
const SECONDS_PER_HOUR = 3600;
/** Hours print at the four decimals the projector rounds its own values to. */
const HOURS_PRECISION = 10_000;

/**
 * The bounded human report: one line per indicator, always the full set.
 *
 * @param {MetricsSources} sources
 * @param {CampaignMetrics} metrics
 * @returns {string}
 */
export function renderMetricsReport(sources, metrics) {
  const lines = [
    `[metrics] ${sources.campaignId} · ${sources.runIds.length} runs · ${sources.events.length} events · ${Object.keys(metrics).length} indicators`,
  ];
  for (const [name, indicator] of Object.entries(metrics)) {
    const records = indicator.count === 1 ? "1 record" : `${indicator.count} records`;
    const unknown = typeof (/** @type {{unknownCount?: number}} */ (indicator).unknownCount) === "number"
      ? ` · ${(/** @type {{unknownCount: number}} */ (indicator)).unknownCount} unknown`
      : "";
    lines.push(`${name.padEnd(NAME_WIDTH)} ${indicator.direction.padEnd(11)} ${formatValue(name, indicator.value).padEnd(24)} · ${records}${unknown}`);
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
  if (typeof value === "number") return SECONDS_INDICATORS.has(name) ? formatSeconds(value) : String(value);
  const maxGroups = MAX_GROUPS_BY_INDICATOR[name] ?? MAX_GROUPS;
  const compact = COMPACT_TOKEN_INDICATORS.has(name);
  const groups = Object.entries(value);
  const shown = groups.slice(0, maxGroups).map(([group, measurement]) => `${group}=${compact ? compactCount(measurement) : measurement}`);
  if (groups.length > shown.length) shown.push(`+${groups.length - shown.length} more`);
  return shown.join(" ");
}

/** @param {number} value @returns {string} */
function compactCount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** @param {number} seconds @returns {string} */
function formatSeconds(seconds) {
  const hours = seconds / SECONDS_PER_HOUR;
  return hours >= 1 ? `${seconds}s (${Math.round(hours * HOURS_PRECISION) / HOURS_PRECISION}h)` : `${seconds}s`;
}
