#!/usr/bin/env bash
# infra/tests/run.sh — T-01 gate: gitleaks, yamllint, ansible-lint, static tests.
# LD-06 (2026-11-07): writer deliverable. Missing tool = FAIL (never skip).
# The Lint class is excluded below: it calls this script (self-recursion).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
export PYTHONDONTWRITEBYTECODE=1
rc=0
step() { name=$1; shift; if "$@"; then echo "ok - $name"; else echo "not ok - $name"; rc=1; fi; }

step gitleaks gitleaks detect --no-git --source infra --no-banner --redact --exit-code 1
# pip --user installs may leave the yamllint script off PATH; the module still counts. Absent = FAIL.
if command -v yamllint >/dev/null; then step yamllint yamllint infra; else step yamllint python -m yamllint infra; fi
# LD-17 (2026-11-07): ansible-lint does not run on native Windows; missing = FAIL only when CI=true.
if ! command -v ansible-lint >/dev/null; then
  if [ "${CI:-}" = "true" ]; then echo "not ok - ansible-lint missing"; rc=1; else echo "SKIP ansible-lint (CI only)"; fi
elif [ -d infra/ansible ]; then step ansible-lint ansible-lint infra/ansible
else echo "ok - ansible-lint (no infra/ansible yet)"; fi
step static python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -k Skeleton -k Gitleaks -k SopsConfig -k SecretsSchema -k ThirdParty
exit $rc
