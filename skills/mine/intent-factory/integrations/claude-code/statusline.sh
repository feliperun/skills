#!/bin/sh
# Claude Code statusLine renderer for intent-factory ambient liveness. Reads
# the session JSON on stdin, reads that repo's .runs/status.json pointer
# (rewritten every controller tick), and prints one line:
#   <run-id> · <state> · <node> <elapsed> · $<usd> · needs you: <n>
# elapsedSec, costUsd and needsYou are precomputed by the controller, so this
# never touches a clock or a node process, only formats. No pointer, an
# unreadable file, or one over the 1 KiB cap prints an empty line, exit 0.
# jq is used when present; otherwise sed/grep pull the flat top-level fields.

set -u
session=$(cat)
repo=$(printf '%s' "$session" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p;s/.*"current_dir":"\([^"]*\)".*/\1/p' | head -n 1)
pointer="$repo/.runs/status.json"
[ -n "$repo" ] && [ -f "$pointer" ] && [ "$(wc -c <"$pointer" | tr -d ' ')" -le 1024 ] || { printf '\n'; exit 0; }

if command -v jq >/dev/null 2>&1; then
  out=$(jq -r '[.runId,.state,(.activeNode//"-"),(.elapsedSec//"-"),(.costUsd//"-"),(.needsYou//0)]|@tsv' "$pointer" 2>/dev/null) || out=
  set -f; IFS='	'; set -- $out; IFS=' '; set +f
  runId=${1:-}; state=${2:-}; node=${3:-}; elapsedSec=${4:-}; costUsd=${5:-}; needsYou=${6:-}
else
  field() { grep -o "\"$1\":\"[^\"]*\"\|\"$1\":[0-9.null-]*" "$pointer" | head -n 1 | sed "s/.*://;s/\"//g"; }
  runId=$(field runId); state=$(field state); node=$(field activeNode)
  elapsedSec=$(field elapsedSec); costUsd=$(field costUsd); needsYou=$(field needsYou)
fi
[ -n "$runId" ] && [ -n "$state" ] || { printf '\n'; exit 0; }
[ -n "$node" ] && [ "$node" != "null" ] || node=-
[ -n "$needsYou" ] && [ "$needsYou" != "null" ] || needsYou=0
elapsed=-
if [ -n "${elapsedSec:-}" ] && [ "$elapsedSec" != "null" ] && [ "$elapsedSec" != "-" ]; then
  h=$((elapsedSec / 3600)); m=$(((elapsedSec % 3600) / 60)); s=$((elapsedSec % 60))
  if [ "$h" -gt 0 ]; then elapsed="${h}h$(printf '%02d' "$m")m"
  elif [ "$m" -gt 0 ]; then elapsed="${m}m$(printf '%02d' "$s")s"
  else elapsed="${s}s"
  fi
fi
usd=-
[ -n "${costUsd:-}" ] && [ "$costUsd" != "null" ] && [ "$costUsd" != "-" ] && usd="\$$costUsd"

printf '%s · %s · %s %s · %s · needs you: %s\n' "$runId" "$state" "$node" "$elapsed" "$usd" "$needsYou"
