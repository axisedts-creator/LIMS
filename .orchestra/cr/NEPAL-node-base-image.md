Title: CR-C1-NEPAL-003: Node base image variant for services/api, services/worker, apps/web (NODE_BASE_IMAGE) is not specified
From chunk: C1            To owner: C0-0D (Dockerfile owner) / founder
Type: bug (missing pin; no schema/api/event/port change)
Blocking? yes for step 8 of infra/cutover/bootstrap.sh: infra/ci/build.sh cannot build lims/api, lims/worker, lims/web without a value.

Problem:
spec/program/02-CONVENTIONS.md s1.1 pins Node.js 26.13.0 ("exact patch in .nvmrc, engines.node, and the Docker base image by digest") but names no image repository or variant. services/api/Dockerfile, services/worker/Dockerfile and apps/web/Dockerfile declare `ARG NODE_BASE_IMAGE` with no default and say "C1 ci/build.sh passes the digest from its lock files". C1 02-TRD s12.2 names no lock for it. No variant (bookworm-slim, alpine, ...) and no digest is recorded for these three. Only C6's services/renderer/Dockerfile.{renderer,sandbox} hard-code `node:26.13.0-bookworm-slim@sha256:add5c17c...`; that is C6's choice, not a C0 spec value.

Proposed change (exact):
1. The owner states the image reference to use, `<repo>:26.13.0[-variant]` (candidate for consistency with C6: `node:26.13.0-bookworm-slim`).
2. C1 records the digest once with `docker buildx imagetools inspect <image>:<tag>` (platform linux/amd64 manifest digest) in `infra/ci/base-images.lock` as `NODE_BASE_IMAGE=<image>@sha256:<64 hex>`.
3. `infra/ci/build.sh` (already changed in N11) reads that file and passes `--build-arg NODE_BASE_IMAGE=...` to every Dockerfile that declares the ARG; it fails closed while the value is empty.
Also: apps/portal/Dockerfile does not exist (C6); build.sh lists it and stops with a clear message.

Backward compatible? yes. Build inputs only; no runtime path changes.
Tenant/security impact: none; this is REQ-SEC-129 (base image by digest) made enforceable.
IRD/regulatory impact: none.
Alternatives considered: a default in each Dockerfile (rejected: LD-173 rule 1, no default); build.sh resolving the digest at build time from a tag (rejected: the digest would not be reviewed in the repo).
Tests that will prove it: infra/tests/static/test_t24_cicd.py (build.sh fails closed without the lock value; passes --build-arg when set).
