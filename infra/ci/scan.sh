#!/usr/bin/env bash
# infra/ci/scan.sh <registry.lims.internal:5000/<repo>@sha256:<hex>>... - trivy scan + SBOM (02-TRD s12.2, AC-20.1).
#   Fails (exit 1) on any CRITICAL vulnerability that has no valid entry in the triage file
#   (TRIAGE_FILE, default infra/ci/trivy-triage.yaml: entries[{id, added, expires}], expires - added <= 72 h,
#   now < expires; 04 I9). This script judges the JSON report itself. Fail closed: trivy failing, an
#   empty/unreadable report, a missing or malformed triage file -> non-zero. Bad arguments -> exit 2.
#   SBOM (CycloneDX) per image into SBOM_DIR (default infra/releases/sbom).
set -euo pipefail

REG="registry.lims.internal:5000"
HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "scan.sh: $*" >&2; exit 2; }

[ $# -ge 1 ] || die "usage: scan.sh <$REG/<repo>@sha256:<hex>>..."
comp='[a-z0-9]+([._-][a-z0-9]+)*'
re="^registry\\.lims\\.internal:5000/${comp}(/${comp})*@sha256:[0-9a-f]{64}\$"
for r in "$@"; do [[ $r =~ $re ]] || die "not a $REG digest reference: $r"; done

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import yaml" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || die "needs python3 with PyYAML"

triage=${TRIAGE_FILE:-$HERE/trivy-triage.yaml}
sbom_dir=${SBOM_DIR:-$HERE/../releases/sbom}
mkdir -p "$sbom_dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail=0
for r in "$@"; do
  trivy image --quiet --format json --output "$work/report.json" "$r" || { echo "scan.sh: trivy failed on $r" >&2; exit 1; }
  rc=0
  "$PY" - "$work/report.json" "$triage" "$r" <<'PYEOF' || rc=$?
import json, sys, yaml
from datetime import datetime, timedelta, timezone

report, triage, ref = sys.argv[1:4]
now = datetime.now(timezone.utc)


def ts(v):
    d = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


try:
    entries = (yaml.safe_load(open(triage, encoding="utf-8")) or {}).get("entries") or []
    allowed = set()
    for e in entries:
        added, expires = ts(e["added"]), ts(e["expires"])
        if not e["id"]:
            raise ValueError("empty id")
        if now < expires and expires - added <= timedelta(hours=72):
            allowed.add(str(e["id"]))
        else:
            print("scan.sh: triage entry %s expired or lives > 72 h: ignored" % e["id"], file=sys.stderr)
except Exception as ex:  # noqa: BLE001 - fail closed on any triage problem
    print("scan.sh: triage file %s unusable: %s" % (triage, ex), file=sys.stderr)
    sys.exit(3)

try:
    doc = json.load(open(report, encoding="utf-8"))
    results = doc.get("Results") or []
except Exception as ex:  # noqa: BLE001
    print("scan.sh: no usable trivy report for %s: %s" % (ref, ex), file=sys.stderr)
    sys.exit(3)

bad = sorted({v["VulnerabilityID"] for r in results for v in (r.get("Vulnerabilities") or [])
              if v.get("Severity") == "CRITICAL" and v["VulnerabilityID"] not in allowed})
for b in bad:
    print("scan.sh: CRITICAL %s in %s has no valid triage entry" % (b, ref), file=sys.stderr)
sys.exit(1 if bad else 0)
PYEOF
  case $rc in 0) ;; 1) fail=1 ;; *) exit 1 ;; esac
  sbom="$sbom_dir/$(printf '%s' "$r" | tr '/:@' '___').cdx.json"
  trivy image --quiet --format cyclonedx --output "$sbom" "$r" || { echo "scan.sh: SBOM failed for $r" >&2; exit 1; }
  [ -s "$sbom" ] || { echo "scan.sh: empty SBOM for $r" >&2; exit 1; }
done
exit "$fail"
