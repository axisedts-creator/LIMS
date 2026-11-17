#!/usr/bin/env bash
# auth_net.sh: AC-26.2 / 07-SEC. GoTrue is attached only to auth_net + db_net (08 A25 D-203), publishes no port,
# and is unreachable from edge_net / render_net members (L3 isolation: no shared network, so no route).
# Env: EDGE_PROBE_CONTAINER (a web/portal container on edge_net), RENDER_PROBE_CONTAINER (renderer on render_net)
#      (required); AUTH_CONTAINER (default supabase-auth-1); AUTH_PORT (default 9999).
# TAP via probe_lib.sh, fail closed (a stopped container or docker error is a failure). Exit 0 ok, 1 failed, 2 usage.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/probe_lib.sh"
[ -n "${EDGE_PROBE_CONTAINER:-}" ] && [ -n "${RENDER_PROBE_CONTAINER:-}" ] || { echo "need EDGE_PROBE_CONTAINER and RENDER_PROBE_CONTAINER" >&2; exit 2; }
A=${AUTH_CONTAINER:-supabase-auth-1}
PORT=${AUTH_PORT:-9999}
case $PORT in '' | *[!0-9]*) echo "bad AUTH_PORT" >&2; exit 2 ;; esac

need_running "$A" "$EDGE_PROBE_CONTAINER" "$RENDER_PROBE_CONTAINER"

# member networks, sorted; names are fixed (external: true, name: auth_net ...), never project-prefixed
nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$A" 2>/dev/null | sort | tr '\n' ' ')
if [ "$nets" = "auth_net db_net " ]; then tap ok "$A is attached to auth_net and db_net only"; else tap fail "$A networks are '$nets' (want: auth_net db_net)"; fi

# no published port: neither a binding in HostConfig nor a host port on the live endpoint
pb=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$A" 2>/dev/null)
hp=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}} {{end}}{{end}}' "$A" 2>/dev/null)
if { [ "$pb" = "{}" ] || [ "$pb" = "null" ]; } && [ -z "${hp// /}" ]; then tap ok "$A publishes no port"; else tap fail "$A publishes a port (bindings $pb, host ports '$hp')"; fi

# unreachable from edge_net / render_net: every address of GoTrue refuses the probe containers
ips=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$A" 2>/dev/null)
[ -n "${ips// /}" ] || { tap fail "$A has no IP address to probe"; finish; }
need_tool "$EDGE_PROBE_CONTAINER" nc
need_tool "$RENDER_PROBE_CONTAINER" nc
for ip in $ips; do
  deny "$EDGE_PROBE_CONTAINER" "$ip" "$PORT"
  deny "$RENDER_PROBE_CONTAINER" "$ip" "$PORT"
done
finish
