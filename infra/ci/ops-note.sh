#!/usr/bin/env bash
# infra/ci/ops-note.sh "<text>" - write one ops_audit record (02-TRD s8.4, 04-UI-UX s5.2).
# Record: one JSON line {"stream":"ops_audit","who","host","what","when"} (when = ISO-8601 UTC).
# Sent to syslog/journal via `logger` (shipped by Fluent Bit); stdout when no logger exists.
# The text is data only: never evaluated; quotes/backslashes/control chars are JSON-escaped,
# so a note can not forge a second record. Empty or blank text -> exit 2, nothing logged.
set -euo pipefail

text="$*"
if [[ -z "${text//[[:space:]]/}" ]]; then
  echo 'usage: ops-note.sh "<text>"  (text must not be empty)' >&2
  exit 2
fi

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # drop any other control character (no raw newline can survive)
  printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177'
}

# SUDO_USER is trusted only when actually running as root via sudo (else forgeable).
who=
if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then who=$SUDO_USER; fi
[[ -n "$who" ]] || who=$(id -un 2>/dev/null || true)
[[ -n "$who" ]] || who=${USER:-unknown}
when=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host=$(hostname 2>/dev/null || echo unknown)

record=$(printf '{"stream":"ops_audit","who":"%s","host":"%s","what":"%s","when":"%s"}' \
  "$(json_escape "$who")" "$(json_escape "$host")" "$(json_escape "$text")" "$when")

if command -v logger >/dev/null 2>&1; then
  logger -t ops_audit -p auth.notice -- "$record"
  echo "ops-note: logged" >&2
else
  printf '%s\n' "$record"
fi
