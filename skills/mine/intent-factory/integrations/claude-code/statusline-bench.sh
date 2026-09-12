#!/usr/bin/env bash
# Bench the Claude Code status-line script: 20 runs over a fixture heartbeat,
# then print the median wall time in milliseconds. Exits 1 when the median is
# 50 ms or more.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/claude-code.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/if-statusline-bench.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.runs/campaigns/if-bench"
cat >"$tmp/.runs/campaigns/if-bench/heartbeat.json" <<'JSON'
{"activeNode":"bench-node","attention":null,"campaignId":"if-bench","checkpoints":{"done":2,"total":5},"generatedAt":1756742580,"lastProgressAt":1756742400,"phase":"P1","runtime":"codex","schemaVersion":1,"state":"running","weightedUsed":1200000,"weightedCap":6000000}
JSON

escaped=${tmp//\\/\\\\}
escaped=${escaped//\"/\\\"}
input="{\"cwd\":\"$escaped\",\"workspace\":{\"current_dir\":\"$escaped\"}}"

times=()
for ((i = 0; i < 20; i++)); do
  elapsed=$( { TIMEFORMAT='%R'; time "$script" <<<"$input" >/dev/null; } 2>&1 )
  ms=$(awk -v s="$elapsed" 'BEGIN { printf "%d", s * 1000 + 0.5 }')
  times+=("$ms")
done

median=$(printf '%s\n' "${times[@]}" | sort -n | awk '
  { samples[NR] = $1 }
  END {
    if (NR % 2 == 1) value = samples[(NR + 1) / 2]
    else value = (samples[NR / 2] + samples[NR / 2 + 1]) / 2
    printf "%d", value + 0.5
  }')

printf 'median %d ms\n' "$median"
if [ "$median" -ge 50 ]; then
  printf 'statusline too slow: median %d ms >= 50 ms\n' "$median" >&2
  exit 1
fi
exit 0
