#!/usr/bin/env bash
# fail2ban_metrics.sh - 02-TRD s6.8 / s11.3 (LimsAuthJailBan). Run every minute.
# Exports lims_ops_fail2ban_bans_total{jail="<jail>"} <Total banned> (counter) for sshd, lims-ratelimit, lims-auth.
# Read-only: only `fail2ban-client status <jail>`. Client addresses are never output.
# Output: $TEXTFILE_DIR/fail2ban.prom (atomic) or stdout when unset. fail2ban unreachable or a count that is not a
# number: exit 1, no sample, stale fail2ban.prom removed (never a healthy-looking 0).
set -u -o pipefail
fail() {
  echo "fail2ban_metrics.sh: $1" >&2
  [ -n "${TEXTFILE_DIR:-}" ] && rm -f "$TEXTFILE_DIR/fail2ban.prom"
  exit 1
}
body=$'# HELP lims_ops_fail2ban_bans_total Addresses banned by a fail2ban jail since it started.\n'
body+=$'# TYPE lims_ops_fail2ban_bans_total counter\n'
for jail in sshd lims-ratelimit lims-auth; do
  out=$(fail2ban-client status "$jail" 2>/dev/null) || fail "fail2ban-client status failed for jail $jail"
  n=$(printf '%s\n' "$out" | sed -n 's/.*Total banned:[[:space:]]*//p' | head -n 1 | tr -d '[:space:]')
  [[ "$n" =~ ^[0-9]+$ ]] || fail "unexpected ban count for jail $jail"
  body+="lims_ops_fail2ban_bans_total{jail=\"$jail\"} $n"$'\n'
done
if [ -z "${TEXTFILE_DIR:-}" ]; then
  printf '%s' "$body"
  exit 0
fi
tmp=$(mktemp "$TEXTFILE_DIR/.fail2ban.prom.XXXXXX") || fail "cannot write $TEXTFILE_DIR"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$body" > "$tmp" && chmod 0644 "$tmp" && mv "$tmp" "$TEXTFILE_DIR/fail2ban.prom" || fail "cannot write fail2ban.prom"
