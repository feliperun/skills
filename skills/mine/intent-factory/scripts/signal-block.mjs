export const SIGNAL_START = "<!-- intent-factory-active:start (managed by intent-factory — read, never edit) -->";
export const SIGNAL_END = "<!-- intent-factory-active:end -->";

/**
 * Replace only a complete runner-managed block with a stable marker. Guidance
 * outside the block remains part of source identity.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeManagedSignalBlock(text) {
  const start = text.indexOf(SIGNAL_START);
  const end = text.indexOf(SIGNAL_END, start + SIGNAL_START.length);
  if (start < 0 || end < start) return text;
  return `${text.slice(0, start)}${SIGNAL_START}\n${SIGNAL_END}${text.slice(end + SIGNAL_END.length)}`;
}
