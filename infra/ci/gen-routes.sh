#!/usr/bin/env bash
# infra/ci/gen-routes.sh - generate infra/edge/public-routes.yaml (02-TRD s6.3, s12.4; CR-C1-004).
#
#   infra/ci/gen-routes.sh [--openapi-dir DIR] > infra/edge/public-routes.yaml
#
# Reads every *.yaml in DIR (default contracts/openapi) and emits one route per
# public prefix from operations marked `x-edge-exposure: public`. Missing = internal;
# any other value fails closed (exit 3). Output is deterministic (no timestamps):
# CI job edge-routes-drift diffs it byte-for-byte against the committed file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/contracts/openapi"
while [ $# -gt 0 ]; do
  case "$1" in
    --openapi-dir) DIR="${2:?--openapi-dir needs a value}"; shift 2 ;;
    *) echo "gen-routes.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -d "$DIR" ] || { echo "gen-routes.sh: no such directory: $DIR" >&2; exit 2; }

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import yaml" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "gen-routes.sh: needs python3 with PyYAML" >&2; exit 2; }

exec "$PY" - "$DIR" <<'PYEOF'
import glob, os, re, sys
import yaml

# Route table (02-TRD s6.3 / s6.5): known public prefixes with owner chunk, phase,
# nginx zone and body limit. Longest matching entry wins. A public operation outside
# the table becomes its own route (template collapsed to a prefix) with no zone and
# the api default body limit, until its owner's CR names them.
TABLE = [  # path, match, owner, phase, zone, body_limit
    ("/v1/instruments/agent/attachments", "prefix", "C7", 1, "agent", "16m"),     # CR-C7-012
    ("/v1/instruments/agent/", "prefix", "C7", 1, "agent", "4m"),                  # 08 A13 D-43, CR-C7-009/012
    ("/v1/reporting/provider-callbacks/", "prefix", "C6", 1, "callback", "256k"),  # CR-C6-013
    ("/v1/payments/result", "exact", "C15", 1, "payments", None),                  # CR-C15-008
    ("/v1/payments/launch/", "prefix", "C15", 1, "payments", None),
    ("/v1/payments/callbacks/", "prefix", "C15", 1, "payments", None),
    ("/v1/engagement/auth/otp-challenges", "prefix", "C16", 3, "otp", None),       # 08 A19 D-122
    ("/v1/identity/auth/patient/session/resolve", "exact", "C2", 3, "psession", None),  # AC-26.1
    ("/v1/identity/auth/patient/session/logout", "exact", "C2", 3, "psession", None),
    ("/v1/identity/mobile/sessions", "prefix", "C17", 3, "login", None),            # 08 R6, R10
]
# Wave-1 operations the TRD lists but contracts/openapi (C0-owned) does not mark
# public yet. Used only where no contract operation produced the route; delete an
# entry once its operations carry `x-edge-exposure: public`.
# Interim basis: CR-C1-T13 (.orchestra/cr/T-13.md); delete SEED when it is accepted.
SEED = {
    "/v1/instruments/agent/": ["GET", "POST"],            # C7 E01-E05, E07, E08
    "/v1/instruments/agent/attachments": ["POST"],        # C7 E06
    "/v1/reporting/provider-callbacks/": ["GET", "POST"],  # C6 CB1 POST, CB2 GET
    "/v1/payments/result": ["GET", "HEAD"],               # C15 P30-P34
    "/v1/payments/launch/": ["GET", "HEAD"],
    "/v1/payments/callbacks/": ["GET", "HEAD"],
}
NEVER_PUBLIC = ("/v1/core/", "/v1/platform/", "/v1/identity/auth/")  # 02-TRD s6.3 "everything else"
METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
EXAMPLE = re.compile(r"^(\s*)examples?\s*:")
SAFE_PATH = re.compile(r"^/v1/[A-Za-z0-9/_.-]+$")


def strip_examples(text):
    """Drop example/examples blocks: never needed for routing, and contract examples may
    hold YAML that PyYAML rejects (identity.yaml otpauth URI in a flow mapping)."""
    out, cut = [], None
    for line in text.splitlines():
        ind = len(line) - len(line.lstrip())
        if cut is not None:
            if not line.strip() or ind > cut:
                continue
            cut = None
        m = EXAMPLE.match(line)
        if m:
            cut = len(m.group(1))
            continue
        out.append(line)
    return "\n".join(out) + "\n"


def die(code, msg):
    sys.stderr.write("gen-routes.sh: %s\n" % msg)
    sys.exit(code)


def route_for(path):
    best = None
    for t in TABLE:
        hit = path == t[0] if t[1] == "exact" else path.startswith(t[0])
        if hit and (best is None or len(t[0]) > len(best[0])):
            best = t
    if best:
        return best
    # Unknown templated paths would collapse to a broad prefix: they need a TABLE entry
    # (owner CR naming zone and body limit) first. Fail closed.
    if "{" in path:
        return None
    return (path, "exact", None, 1, None, None)


routes = {}
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.yaml"))):
    try:
        doc = yaml.safe_load(strip_examples(open(f, encoding="utf-8").read())) or {}
    except yaml.YAMLError as e:
        die(4, "%s: %s" % (f, e))
    stem = os.path.splitext(os.path.basename(f))[0]
    for path, item in sorted((doc.get("paths") or {}).items()):
        for m in METHODS:
            op = (item or {}).get(m)
            if not isinstance(op, dict):
                continue
            exp = op.get("x-edge-exposure", "internal")
            if exp not in ("public", "internal"):
                die(3, "%s %s %s: invalid x-edge-exposure %r (public|internal)" % (f, m.upper(), path, exp))
            if exp != "public":
                continue
            t = route_for(path)
            if t is None:
                die(5, "%s %s %s: templated public path has no route-table entry" % (f, m.upper(), path))
            p, match, owner, phase, zone, body = t
            # SAFE_PATH: the value lands in an nginx `location` line - no spaces, ';', '{', quotes.
            if not SAFE_PATH.match(p) or (p.startswith(NEVER_PUBLIC) and owner is None):
                die(5, "%s %s %s: path may never be public at the edge (02-TRD s6.3)" % (f, m.upper(), path))
            r = routes.setdefault((p, match), {"path": p, "match": match, "owner": owner or stem, "phase": phase,
                                               "methods": set(), "zone": zone, "body_limit": body})
            r["methods"].add(m.upper())

for path, methods in SEED.items():
    t = route_for(path)
    if (t[0], t[1]) not in routes:
        routes[(t[0], t[1])] = {"path": t[0], "match": t[1], "owner": t[2], "phase": t[3],
                                "methods": set(methods), "zone": t[4], "body_limit": t[5]}


def scalar(v):
    return "null" if v is None else str(v)


out = ["---",
       "# GENERATED by infra/ci/gen-routes.sh from operations marked",
       "# `x-edge-exposure: public` (CR-C1-004). Do not hand-edit:",
       "# CI job edge-routes-drift fails on any difference.",
       "routes:"]
for key in sorted(routes):
    r = routes[key]
    out += ["  - path: %s" % r["path"], "    match: %s" % r["match"], "    owner: %s" % r["owner"],
            "    phase: %d" % r["phase"], "    methods: [%s]" % ", ".join(sorted(r["methods"])),
            "    zone: %s" % scalar(r["zone"]), "    body_limit: %s" % scalar(r["body_limit"])]
sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
PYEOF
