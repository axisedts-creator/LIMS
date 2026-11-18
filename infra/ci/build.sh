#!/usr/bin/env bash
# infra/ci/build.sh <release> - build the product images (02-TRD s12.2, AC-20.1).
#   Tags every image lims/<name>:<release> (never :latest), builds only, never pushes: push.sh
#   pushes and records the digests. Dockerfiles are C0/C6's; the list below is the contract.
#   UNVERIFIED: apps/portal/Dockerfile (C6, path not in the spec; the file does not exist yet: build.sh stops
#   with a message when the directory exists but the Dockerfile does not).
# Node base image (02-CONVENTIONS s1.1: Node 26.13.0, base image by digest; LD-173 rule 1: no default in the
#   Dockerfile): every Dockerfile that declares `ARG NODE_BASE_IMAGE` (api, worker, web) gets
#   --build-arg NODE_BASE_IMAGE=<value of NODE_BASE_IMAGE in infra/ci/base-images.lock>. The value must be
#   <image>@sha256:<64 hex>; unset/empty/malformed -> exit 2 before any build (fail closed). The image and tag
#   are not in the spec: CR .orchestra/cr/NEPAL-node-base-image.md. Record the digest once with
#   `docker buildx imagetools inspect <image>:<tag>`. BASE_IMAGES_LOCK overrides the lock path (test seam).
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

# ---- pre-flight (nothing is built if it fails)
lock=${BASE_IMAGES_LOCK:-"$(cd "$(dirname "$0")" && pwd)/base-images.lock"}
node_base=""
if [ -f "$lock" ]; then
  node_base=$(sed -n 's/^NODE_BASE_IMAGE=//p' "$lock" | tail -n 1)
fi
need_base=0
for spec in "${images[@]}"; do
  df="$root/${spec#*:}"
  if [ ! -f "$df" ]; then
    # directory there, Dockerfile not: a real gap (apps/portal/Dockerfile is C6's), not a different tree
    [ ! -d "$(dirname "$df")" ] || die "${spec#*:} not found (owner: C6 for apps/portal); nothing built. Gap recorded in infra/cutover/notes/N11.md"
    continue
  fi
  if grep -q '^ARG NODE_BASE_IMAGE\b' "$df"; then need_base=1; fi
done
if [ "$need_base" -eq 1 ]; then
  [ -n "$node_base" ] || die "NODE_BASE_IMAGE is not set in $lock (image/tag not in the spec: .orchestra/cr/NEPAL-node-base-image.md). Once the owner names it: docker buildx imagetools inspect <image>:<tag>, then write NODE_BASE_IMAGE=<image>@sha256:<64 hex> there"
  [[ $node_base =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_.-]+)?@sha256:[0-9a-f]{64}$ ]] || die "NODE_BASE_IMAGE in $lock is not <image>@sha256:<64 hex>"
fi

for spec in "${images[@]}"; do
  name=${spec%%:*}
  df="$root/${spec#*:}"
  args=()
  if [ -f "$df" ] && grep -q '^ARG NODE_BASE_IMAGE\b' "$df"; then args=(--build-arg "NODE_BASE_IMAGE=$node_base"); fi
  docker build -f "$df" "${args[@]}" -t "lims/$name:$rel" "$root"
done
