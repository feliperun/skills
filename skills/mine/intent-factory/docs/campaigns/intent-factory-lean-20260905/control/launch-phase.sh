#!/bin/sh
# Launch one phase run of intent-factory-lean-20260905 from an immutable controller snapshot.
# usage: launch-phase.sh <contract.json> <run-id> <controller-dir> <preflight.json>
# Idempotent: refuses to relaunch when the run directory already exists (use resume).
set -eu
REPO=/Users/frb/dev/frb/skills
CONTRACT=$1; RUN_ID=$2; CTRL_DIR=$3; PREFLIGHT=$4
RUNNER=$CTRL_DIR/skills/mine/intent-factory/scripts/runner.mjs
RUN_DIR=$REPO/.runs/$RUN_ID
NODE=/Users/frb/.asdf/installs/nodejs/26.8.1/bin/node

if [ -f "$HOME/.config/intent-factory-notify-ford/env" ]; then
  # shellcheck disable=SC1090
  set -a; . "$HOME/.config/intent-factory-notify-ford/env"; set +a  # the file assigns without export
fi
echo "notify bin: ${INTENT_FACTORY_NOTIFY_BIN:-<none>}"
echo "controller: $CTRL_DIR ($(cat "$CTRL_DIR/HEAD" 2>/dev/null || echo unknown))"

if [ -d "$RUN_DIR" ]; then
  echo "run directory exists: $RUN_DIR (use resume, not run)"
  exit 2
fi

"$NODE" "$RUNNER" preflight "$CONTRACT" --json > "$PREFLIGHT"
"$NODE" -e 'const j=require(process.argv[1]); if(!j.ok){console.error("preflight failed"); for(const c of j.checks) if(!c.ok) console.error(" -", c.name, c.detail); process.exit(1)} console.log("preflight ok")' "$PREFLIGHT"

cd "$REPO"
"$NODE" "$RUNNER" run --detach "$CONTRACT"
sleep 3
# Runners from phase 2b on have no supervisor: one controller holds the lock, resume recovers orphans.
if "$NODE" "$RUNNER" 2>&1 | grep -q supervise; then
  "$NODE" "$RUNNER" supervise --detach "$RUN_DIR" --interval 60
fi
"$NODE" "$RUNNER" status "$RUN_DIR" | head -20
