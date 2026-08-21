#!/usr/bin/env bash
#
# init-agentkit — installs the docs + agent kit into a repo.
#
# Usage:
#   install-agentkit.sh [target-dir]     # default: cwd
#   install-agentkit.sh --dry-run        # preview without writing
#   install-agentkit.sh --force          # overwrite existing files
#   install-agentkit.sh --no-hooks       # skip git hook installation
#   install-agentkit.sh --stable         # compatibility-preserving rule 1
#   install-agentkit.sh --greenfield     # break-freely rule 1 (default)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="$SCRIPT_DIR/../templates"
SENTRUX_VERSION_DEFAULT="v0.5.7"

DRY_RUN=0; FORCE=0; NO_HOOKS=0; TARGET=""; VARIANT="greenfield"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --no-hooks) NO_HOOKS=1 ;;
    --stable)     VARIANT="stable" ;;
    --greenfield) VARIANT="greenfield" ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$(pwd)}"
TARGET="$(cd "$TARGET" && pwd)"

# colors
G='\033[32m'; Y='\033[33m'; B='\033[34m'; R='\033[31m'; D='\033[2m'; C='\033[36m'; Z='\033[0m'
say(){ printf "%b\n" "${2:-}$1$Z"; }

[ -d "$TEMPLATES" ] || { say "templates not found: $TEMPLATES" "$R"; exit 1; }

# --- repo context --------------------------------------------------------
PROJECT="$(basename "$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null || echo "$TARGET")")"
DATE="$(date +%F)"
SENTRUX_VERSION="${SENTRUX_VERSION:-$SENTRUX_VERSION_DEFAULT}"

# stack → check suite
if   [ -f "$TARGET/package.json" ]; then CHECK_SUITE="npm run typecheck && npm test"
elif [ -f "$TARGET/Cargo.toml" ];   then CHECK_SUITE="cargo check && cargo test"
elif [ -f "$TARGET/pyproject.toml" ];then CHECK_SUITE="ruff check . && pytest"
else CHECK_SUITE="echo 'TODO: define the check suite (typecheck + test)'"; fi

say "\n🏗  init-agentkit → $PROJECT${DRY_RUN:+}" "$C"
say "   target: $TARGET" "$D"
say "   stack check: $CHECK_SUITE" "$D"
say "   compatibility rule: $VARIANT" "$D"
say "   sentrux: $SENTRUX_VERSION$( [ $DRY_RUN = 1 ] && echo '  (dry-run)')\n" "$D"

# escape & and \ for the sed replacement side
esc(){ printf '%s' "$1" | sed -e 's/[&\\]/\\&/g'; }
# drop the unselected <!-- variant:NAME:start/end --> block, then the surviving markers
DROP="$( [ "$VARIANT" = stable ] && echo greenfield || echo stable )"
variant(){ sed -e "/<!-- variant:$DROP:start -->/,/<!-- variant:$DROP:end -->/d" \
               -e "/<!-- variant:$VARIANT:start -->/d" \
               -e "/<!-- variant:$VARIANT:end -->/d"; }
subst(){ sed -e "s|{{PROJECT}}|$(esc "$PROJECT")|g" -e "s|{{DATE}}|$(esc "$DATE")|g" \
             -e "s|{{SENTRUX_VERSION}}|$(esc "$SENTRUX_VERSION")|g" \
             -e "s|{{CHECK_SUITE}}|$(esc "$CHECK_SUITE")|g" | variant; }

# --- copy templates (never overwriting, unless --force) -----------------------
copied=0; skipped=0
while IFS= read -r src; do
  rel="${src#"$TEMPLATES"/}"
  dest="$TARGET/$rel"
  if [ -e "$dest" ] && [ "$FORCE" = 0 ]; then
    say "  = $rel (exists, kept)" "$D"; skipped=$((skipped+1)); continue
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  + $rel" "$G"; copied=$((copied+1)); continue
  fi
  mkdir -p "$(dirname "$dest")"
  subst < "$src" > "$dest"
  say "  + $rel" "$G"; copied=$((copied+1))
done < <(find "$TEMPLATES" -type f)

# --- guidance symlinks → AGENTS.md --------------------------------------------
say "\n② Guidance symlinks → AGENTS.md" "$B"
for f in CLAUDE.md GEMINI.md CURSOR.md AGENT.md .github/copilot-instructions.md; do
  link="$TARGET/$f"
  # relative target: one ../ per directory level below the repo root
  case "$f" in */*) dest="../AGENTS.md" ;; *) dest="AGENTS.md" ;; esac
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$dest" ]; then
    say "  = $f (ok)" "$D"; continue
  fi
  if [ -e "$link" ] && [ ! -L "$link" ] && [ "$FORCE" = 0 ]; then
    say "  ! $f exists (real file) — use --force to replace it with a symlink" "$Y"; continue
  fi
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$(dirname "$link")"
    ( cd "$(dirname "$link")" && rm -f "$(basename "$f")" && ln -s "$dest" "$(basename "$f")" )
  fi
  say "  + $f → $dest" "$G"
done

# --- git hook via core.hooksPath --------------------------------------------
if [ "$NO_HOOKS" = 0 ] && git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  say "\n③ Git hook (core.hooksPath=githooks)" "$B"
  if [ "$DRY_RUN" = 0 ]; then
    chmod +x "$TARGET"/githooks/* 2>/dev/null || true
    git -C "$TARGET" config core.hooksPath githooks
  fi
  say "  + pre-commit (secrets + sentrux) and commit-msg (Conventional Commits) active" "$G"
fi

# --- sentrux baseline -----------------------------------------------------
say "\n④ Sentrux baseline" "$B"
if command -v sentrux >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 0 ]; then
    ( cd "$TARGET" && sentrux gate --save . ) && say "  + baseline.json generated" "$G" \
      || say "  ! sentrux gate --save failed — generate it manually" "$Y"
  else say "  + would run: sentrux gate --save ." "$G"; fi
else
  say "  ! sentrux CLI missing — baseline.json is a placeholder; install it and run 'sentrux gate --save .' (docs/sentrux.md)" "$Y"
fi

say "\n────────────────────────────────────────" "$D"
say "✅ agent kit installed: $copied created, $skipped kept$( [ $DRY_RUN = 1 ] && echo ' (dry-run)')" "$G"
say "   next: fill in the TODOs in docs/VISION.md and docs/ARCHITECTURE.md," "$D"
say "   commit as 'chore: bootstrap agent kit (init-agentkit)'\n" "$D"
