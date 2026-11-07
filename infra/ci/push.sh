#!/usr/bin/env bash
# infra/ci/push.sh - push images to the Nepal registry (02-TRD s12.2).
#   push.sh <dev|staging|prod> <local-image:tag>...
#     docker push to registry.lims.internal:5000/<image>:<tag>, then release-lock.sh records
#     the pushed digests. Local names carry no registry host. Any failure -> no lock write.
#   push.sh mirror <upstream-image>@sha256:<hex>
#     third-party image: docker pull of exactly that digest (the ops-1 daemon reaches upstream
#     only via the ops Squid proxy, role registry), tag + push into the Nepal registry; fails if
#     the pushed digest differs. Use the platform (linux/amd64) manifest digest: pushing a pulled
#     multi-arch index from the classic image store yields a different digest.
# Assumes the runner's docker is already logged in to the registry (docker config).
set -euo pipefail

REG="registry.lims.internal:5000"
HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "push.sh: $*" >&2; exit 2; }
usage() { die "usage: push.sh <dev|staging|prod> <local-image:tag>... | push.sh mirror <image>@sha256:<hex>"; }

comp='[a-z0-9]+([._-][a-z0-9]+)*'
path_re="^${comp}(/${comp})*\$"

# push <target> -> prints the sha256 hex from `docker push` ("<tag>: digest: sha256:<hex> size: N")
push_digest() {
  local out
  out=$(docker push "$1") || die "docker push $1 failed"
  [[ $out =~ digest:\ sha256:([0-9a-f]{64}) ]] || die "no digest in docker push output for $1"
  echo "${BASH_REMATCH[1]}"
}

[ $# -ge 2 ] || usage

if [ "$1" = mirror ]; then
  [ $# -eq 2 ] || usage
  up=$2
  [[ $up =~ ^(([a-z0-9.-]+(:[0-9]+)?)/)?(${comp}(/${comp})*)@sha256:([0-9a-f]{64})$ ]] ||
    die "mirror needs <image>@sha256:<64 lowercase hex> (digest, never a tag): $up"
  host=${BASH_REMATCH[2]}; path=${BASH_REMATCH[4]}; hex=${up##*sha256:}
  # a first component without '.' or ':' is a repo path, not a host
  if [ -n "$host" ] && [[ $host != *.* && $host != *:* && $host != localhost ]]; then path="$host/$path"; fi
  target="$REG/$path:sha256-${hex:0:12}"
  docker pull "$up"
  docker tag "$up" "$target"
  got=$(push_digest "$target")
  [ "$got" = "$hex" ] || { echo "push.sh: mirrored digest sha256:$got != upstream sha256:$hex" >&2; exit 1; }
  echo "$REG/$path@sha256:$hex"
  exit 0
fi

env=$1; shift
case "$env" in dev|staging|prod) ;; *) die "unknown env '$env' (dev|staging|prod)";; esac
for img in "$@"; do
  name=${img%:*}; tag=${img##*:}
  [[ $img == *:* && $name =~ $path_re && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] ||
    die "bad local image (want <name>:<tag>, lowercase name): $img"
  if [[ $name == */* && ${name%%/*} == *.* ]]; then die "local image must not name a registry host: $img"; fi
done

refs=()
for img in "$@"; do
  name=${img%:*}; tag=${img##*:}
  target="$REG/$name:$tag"
  docker tag "$img" "$target"
  d=$(push_digest "$target")
  refs+=("$REG/$name@sha256:$d")
done
"$HERE/release-lock.sh" "$env" "${refs[@]}"
