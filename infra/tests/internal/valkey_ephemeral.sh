#!/usr/bin/env bash
# valkey_ephemeral.sh: AC-11.1 / 02-TRD s7.4, 04 S11. Valkey keeps nothing
# on disk and is reachable only on app_net: no RDB (`save` ""), no AOF, no
# volume / bind (except the read-only ACL file), /data on tmpfs, no
# published port. CONFIG GET runs as the no-key ACL user `probe`.
# Env: VALKEY_CONTAINER (required). TAP; exit 0 ok, 1 failed, 2 usage.
set -u
. "$(dirname "$0")/probe_lib.sh"
[ -n "${VALKEY_CONTAINER:-}" ] || { echo "need VALKEY_CONTAINER" >&2; exit 2; }
V=$VALKEY_CONTAINER
ACL=/run/secrets/valkey/users.acl

need_running "$V"

# config KEY -> value; fails unless the answer is the two-line "KEY\nvalue"
config() {
  local o
  o=$(docker exec "$V" valkey-cli --no-auth-warning --user probe --pass probe CONFIG GET "$1" 2>/dev/null) || return 1
  [ "$(printf '%s\n' "$o" | sed -n 1p)" = "$1" ] || return 1
  [ "$(printf '%s\n' "$o" | wc -l)" -le 2 ] || return 1
  printf '%s\n' "$o" | sed -n 2p
}
if v=$(config save); then
  [ -z "$v" ] && tap ok "save is empty (no RDB)" || tap fail "save is '$v' (RDB snapshots on)"
else
  tap fail "CONFIG GET save (CLI/auth error)"
fi
if v=$(config appendonly); then
  [ "$v" = no ] && tap ok "appendonly no" || tap fail "appendonly is '$v'"
else
  tap fail "CONFIG GET appendonly (CLI/auth error)"
fi

doc=$(docker inspect "$V" 2>/dev/null) || { tap fail "docker inspect $V"; finish; }
while IFS=$'\t' read -r st msg; do
  [ "$st" = ok ] && tap ok "$V: $msg" || tap fail "$V: $msg"
done < <(printf '%s' "$doc" | python3 -c '
import json, sys
acl = sys.argv[1]
try:
    d = json.load(sys.stdin)[0]
except Exception as e:
    print("fail\tinspect JSON unreadable: %s" % e); sys.exit()
hc, net = d.get("HostConfig") or {}, d.get("NetworkSettings") or {}
def out(ok, msg): print(("ok" if ok else "fail") + "\t" + msg)
bad = [m.get("Destination") for m in d.get("Mounts") or []
       if not (m.get("Type") == "bind" and m.get("Destination") == acl and m.get("RW") is False)]
out(not bad, "no volume or bind mount besides the read-only ACL file %s" % bad)
out("/data" in (hc.get("Tmpfs") or {}), "/data is tmpfs")
ports = [k for k, v in (net.get("Ports") or {}).items() if v]
out(not ports and not any((hc.get("PortBindings") or {}).values()), "no published port %s" % ports)
nets = sorted((net.get("Networks") or {}).keys())
out(nets == ["app_net"], "networks = app_net only (%s)" % nets)
' "$ACL")
finish
