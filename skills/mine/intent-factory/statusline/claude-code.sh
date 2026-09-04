#!/bin/sh
# Claude Code statusLine renderer for intent-factory ambient liveness.
#
# Reads the session JSON on stdin (cwd or workspace.current_dir locates the
# repository), finds the newest .runs/campaigns/*/heartbeat.json under that
# repository by modification time, and prints one bounded status line:
#
#   if <campaignId> <state> <done>/<total> <activeNode> <runtime> \
#     <usedK>k/<capK>k <age>m ago[ · attention: <text>]
#
# Degradation is silent: no heartbeat, an unreadable file, or a heartbeat
# larger than the 1 KiB cap prints an empty line and exits 0. Only stdin, the
# session JSON, the newest 1 KiB heartbeat, and local tools are used; git and
# the network are never invoked.
#
# Process budget: shell builtins, plus jq when it exists, plus exactly one
# other external process — `head -c 1025`, the bounded read. Nothing is
# piped into a second process, and no feature adds a sed, awk or date call.
# The probe is both the read cap and the size check: it returns at most
# 1025 bytes, so a file over the 1 KiB cap is rejected before any parser
# sees it and no tool ever receives the whole file. Where head is absent
# (restricted environments) the shell reads the first line itself and applies
# the same cap, and a heartbeat carrying anything beyond that line degrades.
#
# Parsing is jq alone when jq exists. Otherwise fields come from a POSIX
# builtin JSON reader that consumes strings escape-aware and walks the object
# in order, so an attention value carrying quotes or escaped field names can
# never terminate early or forge another field. The age derives from
# generatedAt because the heartbeat cache is rewritten on every liveness
# fact, so no date or clock process runs.

set -u

# Byte-exact string lengths for the 1 KiB cap and the rendered bound.
LC_ALL=C
export LC_ALL

HEARTBEAT_MAX_BYTES=1024
PROBE_BYTES=1025
MAX_LINE_CHARS=160

tab='	'
nl='
'

# ---------------------------------------------------------------------------
# POSIX builtin JSON reader
#
# json_rest holds the unconsumed text; parse_error latches any malformed
# input so every caller can degrade instead of rendering a guess.
# ---------------------------------------------------------------------------

parse_error=0
json_rest=
json_str=
json_val=
json_plain=

# Consume insignificant whitespace at the head of json_rest.
skip_ws() {
  while :; do
    case $json_rest in
      " "*|"$tab"*|"$nl"*) json_rest=${json_rest#?} ;;
      *) return 0 ;;
    esac
  done
}

# Consume a JSON string at the head of json_rest and leave its raw (still
# escaped) body in json_str. A quote preceded by an odd number of backslashes
# is part of the value, never its terminator.
read_json_string() {
  json_str=
  case $json_rest in
    '"'*) json_rest=${json_rest#?} ;;
    *) parse_error=1; return 0 ;;
  esac
  while :; do
    chunk=${json_rest%%'"'*}
    if [ "$chunk" = "$json_rest" ]; then
      parse_error=1
      return 0
    fi
    json_rest=${json_rest#"$chunk"}
    json_rest=${json_rest#'"'}
    json_str=$json_str$chunk
    slashes=$chunk
    count=0
    while [ "${slashes%\\}" != "$slashes" ]; do
      slashes=${slashes%\\}
      count=$((count + 1))
    done
    if [ $((count % 2)) -eq 0 ]; then
      return 0
    fi
    json_str=$json_str'"'
  done
}

# Consume a scalar token (number, null, true, false) at the head of json_rest.
read_scalar() {
  json_val=
  while :; do
    case $json_rest in
      ''|','*|'}'*|" "*|"$tab"*|"$nl"*) return 0 ;;
      *)
        json_val=$json_val${json_rest%"${json_rest#?}"}
        json_rest=${json_rest#?}
        ;;
    esac
  done
}

# Unescape a raw JSON string body into json_plain. Only the escapes a
# filesystem path can carry are supported; anything else degrades.
unescape_json() {
  json_plain=
  raw=$1
  while [ -n "$raw" ]; do
    prefix=${raw%%\\*}
    if [ "$prefix" = "$raw" ]; then
      json_plain=$json_plain$raw
      return 0
    fi
    json_plain=$json_plain$prefix
    raw=${raw#"$prefix"}
    raw=${raw#?}
    esc=${raw%"${raw#?}"}
    case $esc in
      '"') json_plain=$json_plain'"' ;;
      '\') json_plain=$json_plain'\' ;;
      '/') json_plain=$json_plain'/' ;;
      *) parse_error=1; return 0 ;;
    esac
    raw=${raw#?}
  done
  return 0
}

# ---------------------------------------------------------------------------
# Session JSON: locate the repository
# ---------------------------------------------------------------------------

session=
session_line=
while IFS= read -r session_line || [ -n "$session_line" ]; do
  session="${session}${session_line}"
done

repo=
rest=${session#*'"cwd":"'}
if [ "$rest" = "$session" ]; then
  rest=${session#*'"current_dir":"'}
fi
if [ "$rest" != "$session" ]; then
  json_rest='"'$rest
  parse_error=0
  read_json_string
  if [ "$parse_error" -eq 0 ]; then
    unescape_json "$json_str"
    if [ "$parse_error" -eq 0 ]; then
      repo=$json_plain
    fi
  fi
fi

if [ -z "$repo" ] || [ ! -d "$repo/.runs/campaigns" ]; then
  printf '\n'
  exit 0
fi

# Newest heartbeat under <repo>/.runs/campaigns/*/heartbeat.json by mtime.
newest=
for candidate in "$repo/.runs/campaigns"/*/heartbeat.json; do
  if [ -f "$candidate" ]; then
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
      newest=$candidate
    fi
  fi
done

if [ -z "$newest" ]; then
  printf '\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Bounded read: at most PROBE_BYTES bytes reach the shell, and the same
# mechanism decides whether the file is over the cap.
# ---------------------------------------------------------------------------

content=
if command -v head >/dev/null 2>&1; then
  # The X sentinel survives command substitution's trailing-newline strip, so
  # the length below is the exact byte count the probe returned.
  content=$(head -c "$PROBE_BYTES" "$newest" 2>/dev/null; printf 'X') || content=X
  content=${content%X}
else
  # No bounded-read process available: the shell reads the first line and
  # applies the same cap. A heartbeat is exactly one line, so anything after
  # it means the file is not the bounded artifact and degrades.
  overflow=
  {
    IFS= read -r content || :
    IFS= read -r overflow || :
  } 2>/dev/null <"$newest"
  if [ -n "$overflow" ]; then
    printf '\n'
    exit 0
  fi
fi

if [ -z "$content" ] || [ "${#content}" -gt "$HEARTBEAT_MAX_BYTES" ]; then
  printf '\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------

if command -v jq >/dev/null 2>&1; then
  # jq parses the bounded content (never the file) and renders the whole
  # line: validation, epoch age, field assembly, truncation and attention
  # escaping all happen inside the one jq process. Fields are read
  # individually, so an attention value cannot forge another field.
  line=$(printf '%s' "$content" | jq -r --argjson bound "$MAX_LINE_CHARS" '
    def txt: if type == "string" then . else "" end;
    def uint: if type == "number" and isfinite and . >= 0 and . == floor then . else -1 end;
    (.campaignId | txt) as $cid
    | (.state | txt) as $state
    | ((.checkpoints.done // -1) | uint) as $done
    | ((.checkpoints.total // -1) | uint) as $total
    | ((.weightedUsed // -1) | uint) as $used
    | ((.weightedCap // -1) | uint) as $cap
    | ((.lastProgressAt // -1) | uint) as $last
    | (.activeNode // null) as $active
    | (.runtime // null) as $runtime
    | (.attention // null) as $attention
    | if $cid != "" and $state != "" and $done >= 0 and $total >= 0 and $used >= 0 and $cap >= 0 and $last >= 0 then
        (if $active == null or $active == "" then "-" else $active end) as $activeS
        | (if $runtime == null or $runtime == "" then "-" else $runtime end) as $runtimeS
        | ((now - $last) / 60 | floor) as $age
        | (if $age < 0 then 0 else $age end) as $ageC
        | (($used / 1000) | floor) as $usedK
        | (($cap / 1000) | floor) as $capK
        | (("if " + $cid + " " + $state + " " + ($done | tostring) + "/" + ($total | tostring) + " "
             + $activeS + " " + $runtimeS + " " + ($usedK | tostring) + "k/" + ($capK | tostring) + "k "
             + ($ageC | tostring) + "m ago"
             + (if $attention == null or $attention == "" then ""
                elif ($attention | type) == "string" then " · attention: " + ($attention | tojson | .[1:-1])
                else empty end))[0:$bound])
      else empty
      end
  ' 2>/dev/null) || line=
  case $line in
    *"$nl"*) line= ;;
  esac
  printf '%s\n' "$line"
  exit 0
fi

# jq-less fallback: walk the object with the builtin reader. Values are
# consumed in order, so an attention value carrying \" or an escaped field
# name is returned verbatim and can never overwrite a field parsed later.
hb_campaign=
hb_state=
hb_active=
hb_runtime=
hb_attention=
hb_has_attention=0
hb_done=
hb_total=
hb_used=
hb_cap=
hb_last=
hb_generated=

# $1 key, $2 value, $3 1 when the value was a JSON string.
assign_field() {
  case $1 in
    campaignId) if [ "$3" -eq 1 ]; then hb_campaign=$2; fi ;;
    state) if [ "$3" -eq 1 ]; then hb_state=$2; fi ;;
    activeNode) if [ "$3" -eq 1 ]; then hb_active=$2; fi ;;
    runtime) if [ "$3" -eq 1 ]; then hb_runtime=$2; fi ;;
    attention)
      if [ "$3" -eq 1 ]; then
        hb_attention=$2
        hb_has_attention=1
      fi
      ;;
    weightedUsed) hb_used=$2 ;;
    weightedCap) hb_cap=$2 ;;
    lastProgressAt) hb_last=$2 ;;
    generatedAt) hb_generated=$2 ;;
  esac
  return 0
}

scan_checkpoints() {
  json_rest=${json_rest#?}
  skip_ws
  case $json_rest in
    '}'*) json_rest=${json_rest#?}; return 0 ;;
  esac
  while :; do
    skip_ws
    read_json_string
    if [ "$parse_error" -ne 0 ]; then return 0; fi
    ckey=$json_str
    skip_ws
    case $json_rest in
      ':'*) json_rest=${json_rest#?} ;;
      *) parse_error=1; return 0 ;;
    esac
    skip_ws
    case $json_rest in
      '"'*|'{'*|'['*) parse_error=1; return 0 ;;
      *) read_scalar ;;
    esac
    case $ckey in
      done) hb_done=$json_val ;;
      total) hb_total=$json_val ;;
    esac
    skip_ws
    case $json_rest in
      ','*) json_rest=${json_rest#?} ;;
      '}'*) json_rest=${json_rest#?}; return 0 ;;
      *) parse_error=1; return 0 ;;
    esac
  done
}

scan_heartbeat() {
  skip_ws
  case $json_rest in
    '{'*) json_rest=${json_rest#?} ;;
    *) parse_error=1; return 0 ;;
  esac
  skip_ws
  case $json_rest in
    '}'*) json_rest=${json_rest#?}; return 0 ;;
  esac
  while :; do
    skip_ws
    read_json_string
    if [ "$parse_error" -ne 0 ]; then return 0; fi
    key=$json_str
    skip_ws
    case $json_rest in
      ':'*) json_rest=${json_rest#?} ;;
      *) parse_error=1; return 0 ;;
    esac
    skip_ws
    case $json_rest in
      '"'*)
        read_json_string
        if [ "$parse_error" -ne 0 ]; then return 0; fi
        assign_field "$key" "$json_str" 1
        ;;
      '{'*)
        if [ "$key" = "checkpoints" ]; then
          scan_checkpoints
          if [ "$parse_error" -ne 0 ]; then return 0; fi
        else
          parse_error=1
          return 0
        fi
        ;;
      '['*) parse_error=1; return 0 ;;
      *)
        read_scalar
        assign_field "$key" "$json_val" 0
        ;;
    esac
    skip_ws
    case $json_rest in
      ','*) json_rest=${json_rest#?} ;;
      '}'*) json_rest=${json_rest#?}; return 0 ;;
      *) parse_error=1; return 0 ;;
    esac
  done
}

parse_error=0
json_rest=$content
scan_heartbeat

valid=1
if [ "$parse_error" -ne 0 ]; then valid=0; fi
[ -n "$hb_campaign" ] || valid=0
[ -n "$hb_state" ] || valid=0
case $hb_done in ''|*[!0-9]*) valid=0 ;; esac
case $hb_total in ''|*[!0-9]*) valid=0 ;; esac
case $hb_used in ''|*[!0-9]*) valid=0 ;; esac
case $hb_cap in ''|*[!0-9]*) valid=0 ;; esac
case $hb_last in ''|*[!0-9]*) valid=0 ;; esac
case $hb_generated in ''|*[!0-9]*) valid=0 ;; esac
if [ "$valid" -ne 1 ]; then
  printf '\n'
  exit 0
fi

age=$(( (hb_generated - hb_last) / 60 ))
if [ "$age" -lt 0 ]; then age=0; fi
used_k=$(( hb_used / 1000 ))
cap_k=$(( hb_cap / 1000 ))
if [ -z "$hb_active" ]; then hb_active=-; fi
if [ -z "$hb_runtime" ]; then hb_runtime=-; fi

line="if ${hb_campaign} ${hb_state} ${hb_done}/${hb_total} ${hb_active} ${hb_runtime} ${used_k}k/${cap_k}k ${age}m ago"
if [ "$hb_has_attention" -eq 1 ] && [ -n "$hb_attention" ]; then
  line="${line} · attention: ${hb_attention}"
fi

if [ "${#line}" -gt "$MAX_LINE_CHARS" ]; then
  line=$(printf "%.${MAX_LINE_CHARS}s" "$line")
fi

case $line in
  *"$nl"*) line= ;;
esac

printf '%s\n' "$line"
exit 0
