#!/usr/bin/env bash
# CI gate 6 (AC-0C-2.2): oasdiff 1.35.x breaking check; bypass only with PR label `cr-approved-breaking`.
# Usage: oasdiff.sh <base.yaml> <head.yaml>    env PR_LABELS = PR labels (comma/newline/space separated)
# Exit: 0 pass | 1 breaking, no label | 2 bad args/unreadable file | other = oasdiff tool error (fail closed)
#
# Job definition for 0A (02-TRD gate table row `oasdiff`, gate 6) — run when contracts/openapi/** changed:
#   on: pull_request: types: [opened, synchronize, reopened, labeled, unlabeled]   # label add/remove re-runs gate
#   env: PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}   # never inline ${{ }} in run:
#   run: |
#   for f in $(git diff --name-only origin/main...HEAD -- 'contracts/openapi/*.yaml'); do
#     git show origin/main:"$f" > /tmp/base.yaml 2>/dev/null || continue   # new file: nothing to break
#     bash tools/codegen/oasdiff.sh /tmp/base.yaml "$f"
#   done
set -euo pipefail

LABEL="cr-approved-breaking"

if [ "$#" -ne 2 ]; then
  echo "usage: oasdiff.sh <base.yaml> <head.yaml>" >&2
  exit 2
fi
for f in "$1" "$2"; do
  if [ ! -r "$f" ]; then
    echo "oasdiff.sh: cannot read '$f'" >&2
    exit 2
  fi
done
command -v oasdiff >/dev/null 2>&1 || { echo "oasdiff.sh: oasdiff not found on PATH" >&2; exit 127; }

rc=0
oasdiff breaking "$1" "$2" --fail-on ERR || rc=$?

if [ "$rc" -eq 1 ]; then
  # exact-token match over comma/newline/space separated list
  if printf '%s' "${PR_LABELS:-}" | tr ', \t' '\n\n\n' | grep -qxF -- "$LABEL"; then
    echo "oasdiff.sh: breaking change allowed by PR label '$LABEL'"
    exit 0
  fi
  echo "oasdiff.sh: breaking OpenAPI change; add label '$LABEL' via approved CR to bypass" >&2
fi
exit "$rc"
