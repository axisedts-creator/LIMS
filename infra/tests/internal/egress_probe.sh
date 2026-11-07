#!/usr/bin/env bash
# egress_probe.sh auth — AC-09.3 (auth part), 07-SEC "GoTrue only to the relay:587".
# Runs inside the GoTrue container (docker exec) and checks db_net egress from 02-TRD s5.5 rule 5:
#   allowed: data-1 wg IP :5432, SMTP relay :587.   Everything else must fail.
# Env: DATA_WG_IP, SMTP_RELAY_HOST (required); APP_WG_IP (optional); AUTH_CONTAINER (default supabase-auth-1).
# Output TAP; exit 0 all as expected, 1 mismatch, 2 usage.  Deploy-time test (needs the running stack).
set -u
[ "${1:-}" = auth ] || { echo "usage: egress_probe.sh auth" >&2; exit 2; }
[ -n "${DATA_WG_IP:-}" ] && [ -n "${SMTP_RELAY_HOST:-}" ] || { echo "need DATA_WG_IP and SMTP_RELAY_HOST" >&2; exit 2; }
C=${AUTH_CONTAINER:-supabase-auth-1}
n=0; rc=0
tap() { n=$((n + 1)); if [ "$1" = ok ]; then echo "ok $n - $2"; else echo "not ok $n - $2"; rc=1; fi; }

# Without these, every "must fail" probe would pass for the wrong reason.
[ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" = true ] && tap ok "container $C running" || tap fail "container $C running"
docker exec "$C" sh -c 'command -v nc' >/dev/null 2>&1 && tap ok "nc available in $C" || tap fail "nc available in $C"
[ "$rc" = 0 ] || exit 1

reach() { docker exec "$C" nc -z -w 3 "$1" "$2" >/dev/null 2>&1; }
allow() { if reach "$1" "$2"; then tap ok "reach $1:$2"; else tap fail "reach $1:$2 (must work)"; fi; }
deny()  { if reach "$1" "$2"; then tap fail "reach $1:$2 (must be blocked)"; else tap ok "blocked $1:$2"; fi; }

allow "$DATA_WG_IP" 5432
allow "$SMTP_RELAY_HOST" 587
for p in 22 9100 9187; do deny "$DATA_WG_IP" "$p"; done
for p in 25 465 2525; do deny "$SMTP_RELAY_HOST" "$p"; done
deny 1.1.1.1 443
deny 8.8.8.8 53
deny 169.254.169.254 80
if [ -n "${APP_WG_IP:-}" ]; then for p in 22 8090 9464; do deny "$APP_WG_IP" "$p"; done; fi
echo "1..$n"
exit $rc
