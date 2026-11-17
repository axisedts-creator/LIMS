#!/usr/bin/env bash
# sandbox_envelope.sh: AC-10.1 / 02-TRD s7.5 (08 A25 D-204). Asserts the
# runtime envelope of C6's pdf-sandbox from `docker inspect`, then that only
# the workers reach it and that it reaches nothing.
# Env (required): SANDBOX_CONTAINER, SANDBOX_PORT, WORKER_CONTAINERS (space
# list, positive control), DENY_CONTAINERS (space list). Optional:
# DATA_WG_IP (adds DB-host probes), PROBE_IMAGE. TAP; exit 0/1/2.
# Worker-only reachability depends on br_netfilter (02-TRD s3.2); a failure
# on a real host goes to inventories/DECISION.md.
set -u
. "$(dirname "$0")/probe_lib.sh"
for v in SANDBOX_CONTAINER SANDBOX_PORT WORKER_CONTAINERS DENY_CONTAINERS; do
  [ -n "${!v:-}" ] || { echo "need $v" >&2; exit 2; }
done
S=$SANDBOX_CONTAINER
read -r -a WORKERS <<< "$WORKER_CONTAINERS"
read -r -a DENIED <<< "$DENY_CONTAINERS"

need_running "$S" "${WORKERS[@]}" "${DENIED[@]}"
doc=$(docker inspect "$S" 2>/dev/null) || { tap fail "docker inspect $S"; finish; }

# One line per envelope check: "ok|fail<TAB>text" (python3 parses the JSON).
checks=$(printf '%s' "$doc" | python3 -c '
import json, re, sys
MIB = 1024 ** 2
try:
    d = json.load(sys.stdin)[0]
except Exception as e:
    print("fail\tinspect JSON unreadable: %s" % e); sys.exit()
cfg, hc = d.get("Config") or {}, d.get("HostConfig") or {}
net = d.get("NetworkSettings") or {}
def out(ok, msg): print(("ok" if ok else "fail") + "\t" + msg)
user = str(cfg.get("User") or "").split(":")[0]
out(re.fullmatch(r"[0-9]+", user) is not None and int(user) != 0, "non-root numeric user (%r)" % user)
out(hc.get("ReadonlyRootfs") is True, "read-only rootfs")
out("/work" in (hc.get("Tmpfs") or {}), "tmpfs /work")
out("ALL" in [str(c).upper() for c in hc.get("CapDrop") or []], "cap_drop ALL")
out(not hc.get("CapAdd"), "no cap_add")
out(hc.get("Privileged") is False, "not privileged")
out(any(str(o).startswith("no-new-privileges") and not str(o).endswith("false")
        for o in hc.get("SecurityOpt") or []), "no-new-privileges")
mem = hc.get("Memory") or 0
out(0 < mem <= 512 * MIB, "memory limit <= 512 MiB (%s)" % mem)
cpu = (hc.get("NanoCpus") or 0) / 1e9
if not cpu and (hc.get("CpuQuota") or 0) > 0 and (hc.get("CpuPeriod") or 0) > 0:
    cpu = hc["CpuQuota"] / hc["CpuPeriod"]
out(0 < cpu <= 1, "cpu limit <= 1 (%s)" % cpu)
pids = hc.get("PidsLimit") or 0
out(0 < pids <= 64, "pids_limit <= 64 (%s)" % pids)
nets = sorted((net.get("Networks") or {}).keys())
out(nets == ["render_net"], "networks = render_net only (%s)" % nets)
ports = [k for k, v in (net.get("Ports") or {}).items() if v]
out(not ports and not any((hc.get("PortBindings") or {}).values()), "no published ports %s" % ports)
m = d.get("Mounts") or []
out(len(m) == 1 and m[0].get("Type") == "bind" and m[0].get("RW") is False
    and str(m[0].get("Source", "")).startswith("/run/lims/secrets/pdf-sandbox/")
    and str(m[0].get("Source", "")).endswith("/pdf_sandbox_inbound_token"),
    "exactly one mount: its inbound token, read-only (%s)" % [x.get("Source") for x in m])
env = [str(e).split("=", 1)[0] for e in cfg.get("Env") or []]
px = [k for k in env if k.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy")]
out(not px, "no proxy variables %s" % px)
hk = (cfg.get("Healthcheck") or {}).get("Test") or []
out("/internal/health" in " ".join(map(str, hk)), "healthcheck GET /internal/health")
ip = ((net.get("Networks") or {}).get("render_net") or {}).get("IPAddress") or ""
print("ip\t" + ip)
')
ip=""
while IFS=$'\t' read -r st msg; do
  case $st in
    ok) tap ok "$S: $msg" ;;
    ip) ip=$msg ;;
    *) tap fail "$S: $msg" ;;
  esac
done <<< "$checks"
[ -n "$ip" ] || { tap fail "$S has a render_net address"; finish; }

for c in "${WORKERS[@]}" "${DENIED[@]}" "$S"; do need_tool "$c" nc; done
[ "$rc" = 0 ] || finish

for w in "${WORKERS[@]}"; do allow "$w" "$ip" "$SANDBOX_PORT"; done
for c in "${DENIED[@]}"; do deny "$c" "$ip" "$SANDBOX_PORT"; done
deny "$S" 1.1.1.1 443
deny "$S" 8.8.8.8 53
deny "$S" 169.254.169.254 80
gw=$(prefix24 "$ip").1
deny "$S" "$gw" 53
deny "$S" "$gw" 22
if [ -n "${DATA_WG_IP:-}" ]; then
  for p in 5432 6432 22; do deny "$S" "$DATA_WG_IP" "$p"; done
fi
finish
