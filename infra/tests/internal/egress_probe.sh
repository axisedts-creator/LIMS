#!/usr/bin/env bash
# egress_probe.sh auth — AC-09.3 (auth part), 07-SEC "GoTrue only to the relay:587".
# Runs inside the GoTrue container (docker exec) and checks db_net egress from 02-TRD s5.5 rule 5:
#   allowed: data-1 wg IP :5432, SMTP relay :587.   Everything else must fail.
# Env: DATA_WG_IP, SMTP_RELAY_HOST (required); APP_WG_IP (optional); AUTH_CONTAINER (default supabase-auth-1).
# Output TAP; exit 0 all as expected, 1 mismatch, 2 usage.  Deploy-time test (needs the running stack).
# T-14 (LD-68, tester-implemented): modes `db|edge|proxy <container>`, through probe_lib.sh, fail-closed.
#   db    <c>: db_net member (api, worker, rest, storage): DATA_WG_IP :5432/:6432 only, nothing else.   Env: DATA_WG_IP.
#   edge  <c>: web/portal: no TCP egress at all.                                                        Env: DATA_WG_IP.
#   proxy <c>: api/worker: only path out is Squid: PROXY_ALLOWED_FQDN returns its status (not 000/403/407/5xx),
#              PROXY_DENIED_FQDN gets exactly 403 on CONNECT, direct egress denied.  Env: PROXY_ALLOWED_FQDN, PROXY_DENIED_FQDN;
#              DATA_WG_IP optional (adds the :5432/:6432 allow).
# T-35 (CR-C15-008, LD-45): mode `payments <container>` (staging worker): same Squid-only path as `proxy`, per FQDN.
#   Every PAYMENTS_ALLOWED_FQDNS (comma list, UAT gateways) must answer via Squid (not 000/403/407/5xx);
#   every PAYMENTS_DENIED_FQDNS (comma list, prod gateways + others) must get exactly 403 on CONNECT; direct egress denied.
#   Env: PAYMENTS_ALLOWED_FQDNS, PAYMENTS_DENIED_FQDNS (both required, exit 2 if empty).
set -u
case "${1:-}" in
  db | edge | proxy | payments)
    MODE=$1; C=${2:-}
    [ -n "$C" ] || { echo "usage: egress_probe.sh db|edge|proxy|payments <container>" >&2; exit 2; }
    case $MODE in
      payments) [ -n "${PAYMENTS_ALLOWED_FQDNS:-}" ] && [ -n "${PAYMENTS_DENIED_FQDNS:-}" ] || { echo "need PAYMENTS_ALLOWED_FQDNS and PAYMENTS_DENIED_FQDNS" >&2; exit 2; } ;;
      proxy) [ -n "${PROXY_ALLOWED_FQDN:-}" ] && [ -n "${PROXY_DENIED_FQDN:-}" ] || { echo "need PROXY_ALLOWED_FQDN and PROXY_DENIED_FQDN" >&2; exit 2; } ;;
      *) [ -n "${DATA_WG_IP:-}" ] || { echo "need DATA_WG_IP" >&2; exit 2; } ;;
    esac
    # shellcheck source=probe_lib.sh
    . "$(dirname "${BASH_SOURCE[0]}")/probe_lib.sh"
    need_running "$C"
    need_tool "$C" nc
    if [ "$MODE" = proxy ] || [ "$MODE" = payments ]; then
      if docker exec "$C" sh -c 'command -v curl' >/dev/null 2>&1; then tap ok "curl available in $C"; else tap fail "curl available in $C"; finish; fi
    fi
    if [ "$MODE" = db ]; then
      allow "$C" "$DATA_WG_IP" 5432
      allow "$C" "$DATA_WG_IP" 6432
      for p in 22 9100 9187; do deny "$C" "$DATA_WG_IP" "$p"; done
      pre=$(prefix24 "$DATA_WG_IP"); [ -z "$pre" ] || sweep "$C" "$pre" 443
    elif [ "$MODE" = proxy ] && [ -n "${DATA_WG_IP:-}" ]; then
      allow "$C" "$DATA_WG_IP" 5432
      allow "$C" "$DATA_WG_IP" 6432
    elif [ "$MODE" = edge ]; then
      deny "$C" "$DATA_WG_IP" 5432
      deny "$C" "$DATA_WG_IP" 6432
    fi
    deny "$C" 1.1.1.1 443
    deny "$C" 8.8.8.8 53
    deny "$C" 169.254.169.254 80
    if [ "$MODE" = proxy ]; then
      st=$(docker exec "$C" curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$PROXY_ALLOWED_FQDN/" 2>/dev/null)
      case $st in
        000 | 403 | 407 | 5?? | "") tap fail "allowed $PROXY_ALLOWED_FQDN via Squid: status '${st:-none}'" ;;
        [1-4]??) tap ok "allowed $PROXY_ALLOWED_FQDN via Squid: $st" ;;
        *) tap fail "allowed $PROXY_ALLOWED_FQDN via Squid: unparseable '$st'" ;;
      esac
      st=$(docker exec "$C" curl -sS -o /dev/null -w '%{http_connect}' --max-time 10 "https://$PROXY_DENIED_FQDN/" 2>/dev/null)
      if [ "$st" = 403 ]; then tap ok "denied $PROXY_DENIED_FQDN: 403 on CONNECT"; else tap fail "denied $PROXY_DENIED_FQDN must be 403 on CONNECT, got '${st:-none}'"; fi
    fi
    if [ "$MODE" = payments ]; then
      IFS=, read -r -a _al <<<"$PAYMENTS_ALLOWED_FQDNS"
      IFS=, read -r -a _de <<<"$PAYMENTS_DENIED_FQDNS"
      for f in "${_al[@]}"; do
        st=$(docker exec "$C" curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$f/" 2>/dev/null)
        case $st in
          000 | 403 | 407 | 5?? | "") tap fail "allowed $f via Squid: status '${st:-none}'" ;;
          [1-4]??) tap ok "allowed $f via Squid: $st" ;;
          *) tap fail "allowed $f via Squid: unparseable '$st'" ;;
        esac
      done
      for f in "${_de[@]}"; do
        st=$(docker exec "$C" curl -sS -o /dev/null -w '%{http_connect}' --max-time 10 "https://$f/" 2>/dev/null)
        if [ "$st" = 403 ]; then tap ok "denied $f: 403 on CONNECT"; else tap fail "denied $f must be 403 on CONNECT, got '${st:-none}'"; fi
      done
    fi
    finish
    ;;
esac
[ "${1:-}" = auth ] || { echo "usage: egress_probe.sh auth|db|edge|proxy|payments" >&2; exit 2; }
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
