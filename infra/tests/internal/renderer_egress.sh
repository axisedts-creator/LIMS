#!/usr/bin/env bash
# renderer_egress.sh: AC-09.1 / 02-TRD s7.4. The renderer (render_net only,
# internal) must reach nothing: internet, cloud metadata, the DB host, any
# wg peer on 22 (WG_PEER_IPS, else host slots of DATA_WG_IP's /24), the
# pdf-sandbox. Env: RENDERER_CONTAINER, DATA_WG_IP (required); PROBE_IMAGE,
# SANDBOX_IP, SANDBOX_PORT (default 8080), WG_PEER_IPS optional. TAP; exit 0 ok, 1 failed, 2 usage.
set -u
. "$(dirname "$0")/probe_lib.sh"
[ -n "${RENDERER_CONTAINER:-}" ] && [ -n "$(prefix24 "${DATA_WG_IP:-}")" ] ||
  { echo "need RENDERER_CONTAINER and DATA_WG_IP (IPv4)" >&2; exit 2; }
C=$RENDERER_CONTAINER

need_running "$C"
need_tool "$C" nc
[ "$rc" = 0 ] || finish

deny "$C" 1.1.1.1 443
deny "$C" 8.8.8.8 53
deny "$C" 169.254.169.254 80
for p in 5432 6432 22; do deny "$C" "$DATA_WG_IP" "$p"; done
sweep "$C" "$(prefix24 "$DATA_WG_IP")" 22
[ -z "${SANDBOX_IP:-}" ] || deny "$C" "$SANDBOX_IP" "${SANDBOX_PORT:-8080}"
finish
