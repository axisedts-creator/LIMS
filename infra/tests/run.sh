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
step yamllint yamllint infra
if [ -d infra/ansible ]; then step ansible-lint ansible-lint infra/ansible; else command -v ansible-lint >/dev/null && echo "ok - ansible-lint (no infra/ansible yet)" || { echo "not ok - ansible-lint missing"; rc=1; }; fi
step static python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -k Skeleton -k Gitleaks -k SopsConfig -k SecretsSchema -k ThirdParty
exit $rc
