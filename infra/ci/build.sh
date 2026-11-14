#!/usr/bin/env bash
# infra/ci/build.sh <release> - build the product images (02-TRD s12.2, AC-20.1).
#   Tags every image lims/<name>:<release> (never :latest), builds only, never pushes: push.sh
#   pushes and records the digests. Dockerfiles are C0/C6's; the list below is the contract.
#   UNVERIFIED: apps/portal/Dockerfile (C6, path not in the spec) and the base-digest --build-arg
#   names from the lock files (02-TRD s12.2); add them here when C0/C6 publish them.
# No secret ever goes in a --build-arg (it would stay in the image history).
set -euo pipefail

die() { echo "build.sh: $*" >&2; exit 2; }
[ $# -eq 1 ] || die "usage: build.sh <release>"
rel=$1
[[ $rel =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad release id: $rel"

root=$(cd "$(dirname "$0")/../.." && pwd)
# name:dockerfile (context = repo root)
images=(
  "api:services/api/Dockerfile"
  "worker:services/worker/Dockerfile"
  "web:apps/web/Dockerfile"
  "portal:apps/portal/Dockerfile"
  "renderer:services/renderer/Dockerfile.renderer"
  "pdf-sandbox:services/renderer/Dockerfile.sandbox"
)
for spec in "${images[@]}"; do
  name=${spec%%:*}
  docker build -f "$root/${spec#*:}" -t "lims/$name:$rel" "$root"
done
