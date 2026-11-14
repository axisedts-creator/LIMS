#!/usr/bin/env bash
# registry_egress.sh - T-23 / AC-20.1 / 02-TRD s12.2, CR-C1-006: product hosts pull only from the Nepal registry.
# Run ON a product host (data-1, app-1, dr-1) at deploy time. TAP output.
#   must work : tcp REGISTRY_HOST:REGISTRY_PORT (default registry.lims.internal:5000)
#   must fail : tcp 443 to every foreign registry below, and to a bare internet IP
# Env: REGISTRY_HOST, REGISTRY_PORT (optional), NC (default nc), FOREIGN_REGISTRIES (space list, optional override).
# Exit 0 = all as expected, 1 = mismatch (a foreign registry is reachable, or the Nepal registry is not).
set -u
NC=${NC:-nc}
H=${REGISTRY_HOST:-registry.lims.internal}
P=${REGISTRY_PORT:-5000}
FOREIGN=${FOREIGN_REGISTRIES:-"registry-1.docker.io index.docker.io auth.docker.io ghcr.io quay.io gcr.io public.ecr.aws mcr.microsoft.com registry.k8s.io"}
n=0; rc=0
tap() { n=$((n + 1)); if [ "$1" = ok ]; then echo "ok $n - $2"; else echo "not ok $n - $2"; rc=1; fi; }

# Without a working probe tool every "must fail" below would pass for the wrong reason.
command -v "$NC" >/dev/null 2>&1 && tap ok "probe tool $NC available" || { tap fail "probe tool $NC available"; echo "1..$n"; exit 1; }

reach() { "$NC" -z -w 3 "$1" "$2" >/dev/null 2>&1; }
if reach "$H" "$P"; then tap ok "reach Nepal registry $H:$P"; else tap fail "reach Nepal registry $H:$P (must work)"; fi
for f in $FOREIGN; do
  if reach "$f" 443; then tap fail "foreign registry $f:443 reachable (must be blocked)"; else tap ok "blocked $f:443"; fi
done
if reach 1.1.1.1 443; then tap fail "1.1.1.1:443 reachable (must be blocked)"; else tap ok "blocked 1.1.1.1:443"; fi
echo "1..$n"
exit $rc
