# probe_lib.sh: sourced by renderer_egress.sh, sandbox_envelope.sh,
# valkey_ephemeral.sh, egress_probe.sh (T-14). TAP output; fail closed: a
# stopped container, a missing probe tool or a docker error is a failure,
# never a "blocked" pass. Probes run inside the container (docker exec nc)
# or, with PROBE_IMAGE (digest-pinned, has nc), in a helper container that
# shares the probed container's network namespace.
# shellcheck shell=bash
n=0
rc=0
tap() { n=$((n + 1)); if [ "$1" = ok ]; then echo "ok $n - $2"; else echo "not ok $n - $2"; rc=1; fi; }
finish() { echo "1..$n"; exit "$rc"; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

# need_running C...: tap each; stop early (exit 1) if any is down.
need_running() {
  local c ok=1
  for c in "$@"; do
    if running "$c"; then tap ok "container $c running"; else tap fail "container $c running"; ok=0; fi
  done
  [ "$ok" = 1 ] || finish
}

# need_tool C TOOL: the probe path works in C (positive control).
need_tool() {
  if [ -n "${PROBE_IMAGE:-}" ] && [ "$2" = nc ]; then
    if docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 &&
       docker run --rm --network "container:$1" "$PROBE_IMAGE" true >/dev/null 2>&1; then
      tap ok "probe image usable in the netns of $1"
    else
      tap fail "probe image $PROBE_IMAGE usable in the netns of $1"
    fi
  elif docker exec "$1" sh -c "command -v $2" >/dev/null 2>&1; then
    tap ok "$2 available in $1"
  else
    tap fail "$2 available in $1"
  fi
}

# reach SRC HOST PORT -> 0 connected, 1 refused/blocked, 2 probe error
reach() {
  local r
  if [ -n "${PROBE_IMAGE:-}" ]; then
    docker run --rm --network "container:$1" --cap-drop ALL \
      --security-opt no-new-privileges:true "$PROBE_IMAGE" nc -z -w 3 "$2" "$3" >/dev/null 2>&1
  else
    docker exec "$1" nc -z -w 3 "$2" "$3" >/dev/null 2>&1
  fi
  r=$?
  [ "$r" = 0 ] && return 0
  [ "$r" -ge 125 ] && return 2
  return 1
}

allow() {
  if reach "$1" "$2" "$3"; then tap ok "$1 reaches $2:$3"; else tap fail "$1 reaches $2:$3 (must work)"; fi
}

deny() {
  reach "$1" "$2" "$3"
  case $? in
    0) tap fail "$1 reaches $2:$3 (must be blocked)" ;;
    1) tap ok "$1 blocked to $2:$3" ;;
    *) tap fail "$1 -> $2:$3 probe error" ;;
  esac
}

# wg_peers A.B.C -> WG_PEER_IPS (the role passes every inventory wg_ip) or,
# unset, the host slots of the wg /24: .11-.14 (dev/staging numbering)
# and .21/.31/.41/.51 (02-TRD s3.2, LD-45 backup host) [CONV].
wg_peers() {
  if [ -n "${WG_PEER_IPS:-}" ]; then echo "$WG_PEER_IPS"; return; fi
  local i
  for i in 11 12 13 14 21 31 41 51; do echo "$1.$i"; done
}

# sweep SRC A.B.C PORT: no wg peer reachable on PORT (parallel probes).
sweep() {
  local d h bad=""
  d=$(mktemp -d)
  for h in $(wg_peers "$2"); do
    { reach "$1" "$h" "$3"; echo $? > "$d/$h"; } &
  done
  wait
  for h in $(wg_peers "$2"); do
    [ "$(cat "$d/$h" 2>/dev/null)" = 1 ] || bad="$bad $h"
  done
  rm -rf "$d"
  if [ -z "$bad" ]; then tap ok "$1 blocked to wg peers :$3"; else tap fail "$1 -> wg peers :$3 reachable or probe error:$bad"; fi
}

# prefix24 IPV4 -> A.B.C (empty if not IPv4)
prefix24() { [[ ${1:-} =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]] && echo "${BASH_REMATCH[1]}"; }
