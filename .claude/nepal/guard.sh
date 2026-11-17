#!/usr/bin/env bash
# Path-ownership guard for the nepal-migration agent. Reuses the repo's own gate (tools/lint/check-paths.ts).
# Usage: .claude/nepal/guard.sh <virtual-branch> [base-ref]
#   <virtual-branch>  c01/nepal-cutover (infra) | c<NN>/nepal-<topic> (web chunk) | c00-0<a-d>/<topic>
#   [base-ref]        default HEAD (checks uncommitted + untracked work); pass origin/main to check a whole branch
# Exit 0 = every changed path is owned by the virtual branch's chunk. Non-zero = do not commit.
set -euo pipefail
branch="${1:?usage: guard.sh <virtual-branch> [base-ref]}"
base="${2:-HEAD}"
cd "$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
{ git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u > "$tmp/files.txt"
: > "$tmp/body.txt"
if [ ! -s "$tmp/files.txt" ]; then echo "guard: no changes"; exit 0; fi
# Hard denies on top of ownership: read-only trees and secret-shaped files.
if grep -E '^(spec/|\.orchestra/(roles|tasks|.*\.ps1|README\.md))' "$tmp/files.txt" | grep -vE '^\.orchestra/(cr|notes)/' ; then
  echo "guard: read-only path touched (spec/ or .orchestra/)" >&2; exit 1
fi
if grep -vE '\.(example|sample)$' "$tmp/files.txt" | grep -E '(^|/)([^/]*\.env(\.[^/]*)?|\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|age)|id_(rsa|ed25519)|[^/]*keys?\.txt)$'; then
  echo "guard: secret-shaped file in change set" >&2; exit 1
fi
# Agent-kit and notes paths are outside chunk ownership by design (see .orchestra/cr/NEPAL-agent-ownership.md).
grep -vE '^(\.claude/|\.orchestra/(cr|notes)/)' "$tmp/files.txt" > "$tmp/owned.txt" || true
if [ ! -s "$tmp/owned.txt" ]; then echo "guard: only kit/notes paths changed - ok"; exit 0; fi
node tools/lint/check-paths.ts --branch "$branch" --files "$tmp/owned.txt" --body "$tmp/body.txt" 2> >(grep -v -e MODULE_TYPELESS -e 'Reparsing as ES' -e 'To eliminate this' -e 'trace-warnings' >&2)
