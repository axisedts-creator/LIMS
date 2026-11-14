#!/usr/bin/env bash
# Bridge agent CI entry points (02-TRD §16, CR-C7-013).
# Usage: build/ci.sh build | sessions | tls-gate | release-tag-check <agent.exe>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cmd_build() {
  go vet ./...
  staticcheck ./...
  unformatted="$(gofmt -l .)"
  if [ -n "$unformatted" ]; then
    echo "gofmt -l: unformatted files:" >&2
    echo "$unformatted" >&2
    exit 1
  fi
  mkdir -p "$ROOT/out"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o "$ROOT/out/" ./cmd/...
  go test ./...
}

cmd_sessions() {
  # Simulator session suite (02-TRD §15.3, AC-21.1).
  go test ./internal/... -run TestSessions
}

cmd_tls_gate() {
  # 02-TRD §5.7: no InsecureSkipVerify outside _test.go.
  local hits
  hits="$(grep -rnE 'InsecureSkipVerify' --include='*.go' --exclude='*_test.go' . || true)"
  if [ -n "$hits" ]; then
    echo "tls-gate: InsecureSkipVerify outside _test.go:" >&2
    echo "$hits" >&2
    exit 1
  fi
  echo "tls-gate: ok"
}

cmd_release_tag_check() {
  # 02-TRD §5.11: release binary must not be built with the nonprod tag.
  local bin="${1:-}"
  if [ -z "$bin" ] || [ ! -f "$bin" ]; then
    echo "release-tag-check: usage: ci.sh release-tag-check <agent.exe> (file must exist)" >&2
    exit 2
  fi
  local info
  info="$(go version -m "$bin")"
  if echo "$info" | grep -qE -- '-tags=([^[:space:]]*,)?nonprod(,|[[:space:]]|$)'; then
    echo "release-tag-check: $bin was built with the nonprod tag" >&2
    exit 1
  fi
  echo "release-tag-check: ok"
}

case "${1:-}" in
  build) cmd_build ;;
  sessions) cmd_sessions ;;
  tls-gate) cmd_tls_gate ;;
  release-tag-check) shift; cmd_release_tag_check "$@" ;;
  *)
    echo "usage: ci.sh build|sessions|tls-gate|release-tag-check <agent.exe>" >&2
    exit 2
    ;;
esac
