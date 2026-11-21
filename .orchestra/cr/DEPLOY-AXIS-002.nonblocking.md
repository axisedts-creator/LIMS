Title: CR-C1-DEPLOY-002: first real prod deploy, part 2: migrate runner, release lock bootstrap, push path and runtime inputs
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (tables are never created, app stack cannot start); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to CR-C1-DEPLOY-001 (`DEPLOY-AXIS-001.nonblocking.md`): this CR covers only what 001 does NOT. 001 items 1-9 (web/renderer/portal builds, pgbackrest Dockerfile, `supabase_stack` role, audit passwords, upstream files, Squid, small items) are not repeated here. Items below were found by reading the repo after 001, plus the agent run that tests the 001 fixes. Items marked (read-only finding) were found by reading the repo, not by running it.

## Items

### 1. Migration runner commands do not exist  (To: C0-0B / C1, see 01-CHUNK-MAP §3 for `db/` and `package.json` owners)
Problem: `infra/ansible/playbooks/deploy.yml:139-175` runs a `migrate` container (`infra/compose/lims/compose.app.yml:110-121`) with `pnpm db:migrate`, then `pnpm worker:registry-sync`, then `pnpm db:seed`. A search of every `package.json` in the repo finds none of these three scripts. Only `identity:bootstrap-platform-admin` exists (`services/api/package.json:10`). `.orchestra/cr/T-08.md:5` already marks `db:seed` as UNVERIFIED. On a fresh host the first deploy fails before any table exists.
Proposed change: define `db:migrate`, `db:seed` and `worker:registry-sync` in the package that owns them (root or `db/`), with the same behaviour deploy.yml documents (migrations in timestamp order; seeds 001-003 only in prod, `--all` in staging/dev), or change deploy.yml to call the real commands. State which one is chosen in the PR.
Backward compatible? yes.

### 2. migrate container has no migrations to run  (To: C0-0D for the API Dockerfile, C1 for compose)
Problem: `services/api/Dockerfile:28-32` copies only `contracts`, `packages`, `services/api` and `tools/node-ts` into the runtime image. The `migrate` service uses an app image, so `db/migrations`, `db/seeds`, `db/tools` and `services/worker` (needed for `registry-sync`) are not in it.
Proposed change: build a dedicated migrator image (Dockerfile in `infra/images/` or `db/`) that contains `db/`, the worker registry-sync entry point and the node tooling, and use it for the `migrate` service. Do not widen the production api image.
Backward compatible? yes (new image, compose change).

### 3. clamd image variable never set by the runtime role  (To: C1)
Problem: `compose.app.yml:296` requires `${LIMS_CLAMD_IMAGE:?...}`. `deploy.yml:60` and `dr-promote.yml:161` set it from `lims_runtime_images.clamd`. The `lims_runtime` role (`roles/lims_runtime/tasks/main.yml:38-49`, assert list at `:16-18`) does not, so a `site.yml` run (first provisioning) fails at `docker compose up` with "LIMS_CLAMD_IMAGE required". (read-only finding)
Proposed change: add `LIMS_CLAMD_IMAGE` to the role's compose environment and to its assert list, matching deploy.yml.
Backward compatible? yes.

### 4. Release lock is never turned into `lims_runtime_images`  (To: C1)
Problem: `infra/ci/lib-deploy.sh:197-218` turns the lock into `deploy_<name>_image` variables for `lims/*` keys only. `lims_runtime_images` (a dict with api, worker, web, portal, renderer, pdf_sandbox, valkey, squid, clamd; partner if enabled) defaults to `{}` (`roles/lims_runtime/defaults/main.yml:218`) and is defined in no inventory, so `site.yml` needs it passed by hand with `-e`. Third-party digests (valkey, squid, clamd) are not produced by `build.sh`. `infra/releases/` does not exist until the first `push.sh`. (read-only finding)
Proposed change: a small script or playbook step that reads `infra/releases/<env>.lock.yaml` and writes an extra-vars file for `lims_runtime_images` (including the third-party keys), and a documented first-release order: build, push, mirror third-party, lock, deploy. Document it in `infra/README.md` (it still calls `infra/ci/` "stubs", which is stale).
Backward compatible? yes.

### 5. Registry push has no credential path  (To: C1)
Problem: the only credential id is `registry_htpasswd` (`infra/secrets/schema/prod.secrets.schema.yaml:242-246`). Its value is operator-supplied (`secrets_generate.py:11-12`), `registry/tasks/server.yml:4-9,32-37` expects a variable of that name, and nothing maps the decrypted secret to that variable (`secrets_render/defaults/main.yml:34-37` says such ids are "read by their own role", and no loader exists). `infra/ci/push.sh:9` assumes docker is already logged in; the repo has no `docker login` step and `runbooks/secrets.md` has no registry section. A fresh host ends with a running registry nobody can push to. (read-only finding; on axis the htpasswd passwords were not stored.)
Proposed change: (a) a separate push credential id (e.g. `registry_push_user` / `registry_push_password`, generated like other passwords) and a pull credential for hosts; (b) the registry role builds the bcrypt htpasswd from them inside Ansible with `no_log`, never on a command line; (c) `push.sh` does `docker login --password-stdin` from tmpfs; (d) a short runbook section for creating and rotating it without printing it.
Backward compatible? yes (additive ids; `registry_htpasswd` can remain as a fallback).

### 6. Public hostnames and mail inputs are not defined anywhere  (To: C1)
Problem: required with no definition in any inventory: `smtp_relay_fqdn` (`egress_proxy/tasks/main.yml:7-12`, `monitoring/tasks/main.yml:8`), `acme_email`, per-origin hostnames for `edge_nginx_tls_origins` / `acme_origins` (staff web, portal, api, partner), and the public base URL used in GoTrue and invitation emails. `docs/ops/GO-LIVE-OWN-SERVER.md` still shows `lims.example.com`. Operators learn about each missing var by failing a play. (read-only finding)
Proposed change: one documented block in the inventory examples (`group_vars/all.yml` for prod and prod-lean) listing all hostname, mail and ACME vars with placeholders and a preflight play that lists every missing one at once.
Backward compatible? yes.

### 7. DB role and grant gaps  (To: C0-0B / C1)
Problem:
- `db/bootstrap/00_roles.sql:10-26` creates `lims_migration` without LOGIN, and the "migration-window playbook" that is meant to enable it was not found.
- `db/bootstrap/01_database.sql` has no CONNECT grant for the GoTrue, Storage and PostgREST roles; the file marks this UNVERIFIED until SP-3.
- `db/provisioning/create-storage-buckets.mjs` (11 buckets) has never run against a real stack (`db/provisioning/README.md:19`) and has no playbook step.
(read-only findings)
Proposed change: add the missing LOGIN/CONNECT statements or document why they are not needed, add the playbook step for the bucket script after Storage is healthy, and verify on a real stack.
Backward compatible? yes.

### 8. No documented first-admin sequence  (To: C1 docs, C2 identity)
Problem: the first-admin path exists in code (`identity:bootstrap-platform-admin`, then `POST /v1/identity/platform/tenants` and activate, TOTP enrolment at first login) but `docs/ops/GO-LIVE-OWN-SERVER.md` and `docs/ops/PRODUCTION-BAR.md` do not describe it, and the last one refers to a `push-cloud.ps1` that is not in the repo. The admin password-reset email needs a working SMTP relay and the real public URL, so SMTP and domain must be live first. (read-only finding)
Proposed change: a "Day 0" runbook: ordered steps with the commands above, the services that must be up before each, and what needs SMTP/domain. Remove or fix the dangling `push-cloud.ps1` reference.
Backward compatible? yes.

Tenant/security impact: none new. Item 5 adds credentials, to be stored sops-encrypted like the others and never printed. No PHI fields, no new public surface.
IRD/regulatory impact: none.
Alternatives considered: working around each item in the deploy copy on the host (done for the first deploy where possible; not repeatable for a rebuild or DR).
Tests that will prove it:
- CI: `pnpm db:migrate` and `pnpm db:seed` against an empty Postgres in the devstack, producing the expected tables;
- CI: the migrator image builds and `migrate` runs from it;
- static test: `lims_runtime` environment contains every `${VAR:?}` that `compose.app.yml` requires;
- dry run on an empty host: build, push, lock, `lims_runtime_images` file, `site.yml`, deploy, bootstrap-platform-admin, with no manual variable passing.
