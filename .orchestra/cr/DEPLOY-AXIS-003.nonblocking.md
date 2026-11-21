Title: CR-C1-DEPLOY-003: first real prod deploy, part 3: findings from the night6 run (migrations applied to a real database, first release pushed)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live; no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 001 (`DEPLOY-AXIS-001`) covered the build and stack-start defects, 002 (`DEPLOY-AXIS-002`) the migrate/lock/registry/inputs gaps. This CR records what the night6 run learned when it actually executed the 002 fixes against a real Postgres, registry and Docker host. Fixes for these items exist in the deploy copy on the host and are in `DEPLOY-AXIS-002.patch` (held by the deployer, not in the repo). Evidence class per item: (verified) = I checked it in the repo; (reported) = night6 report, run on the host, not re-checked by me.

## Items

### 1. All scripts in `infra/ci/` lack the exec bit  (To: C1) (verified)
Problem: `git ls-files -s infra/ci` shows mode 100644 for every shell script (`agent-release.sh`, `build.sh`, `deploy.sh`, `gen-routes.sh`, `import-rules.sh`, `lib-deploy.sh`, `ops-note.sh`, `promote.sh`, `push.sh`, `release-lock.sh`, `rollback.sh`, `scan.sh`, `smoke.sh`). Night6: `push.sh` failed with "Permission denied" running `release-lock.sh`; earlier `db-bootstrap` failed on `ops-note.sh`. (001 item 9 named only `ops-note.sh`; the problem is the whole directory.)
Proposed change: `git update-index --chmod=+x infra/ci/*.sh`, plus a CI check that fails when a `#!`-script under `infra/` or `tools/` is not executable.
Backward compatible? yes.

### 2. Migration runner: no `atlas.sum`  (To: C0-0B / C1) (verified, reported)
Problem: `db/migrations/` has 66 files and no `atlas.sum` (verified). Atlas `migrate apply` refuses a directory without it. Night6 worked around it in the runner by hashing a temporary copy; `db/migrations` is never modified.
Proposed change: decide one of: commit `atlas.sum` and regenerate it in CI (`atlas migrate hash`), or keep the runner's temp-copy hashing and document it. Either way a CI step must prove "empty Postgres, apply all 66, apply again = nothing to do".
Backward compatible? yes.

### 3. graphile_worker install must happen between two migrations  (To: C0-0B) (reported)
Problem: migration `20261105001200` needs `graphile_worker.jobs` to exist, but nothing installs the graphile_worker schema before it. Night6's `db/tools/migrate.mjs` applies the first 12 files, runs `graphile-worker --schema-only` as session role `lims_queue` over a direct connection, then applies the rest, and re-revokes the two temporary CREATE grants on failure. The repo describes this "window" (SP-2 D-201) but no runnable step exists. Atlas community 1.3.1 has no `--to-version`; the runner uses `migrate apply <n>`.
Proposed change: adopt a runner with this behaviour as the repo's `db:migrate` (see 002 item 1), or move the graphile_worker schema creation into a migration so the order is self-contained.
Backward compatible? yes.

### 4. `migrations_meta` schema and grants exist only as dev glue  (To: C1, `db/bootstrap`) (verified in dev; reported for prod)
Problem: `tools/devstack/up.ts:66-68` creates `migrations_meta` and its grants for dev; `db/bootstrap/01_database.sql` did not, so a production database has no revisions schema. Also, migration `20261105000000` leaves the session in `SET LOCAL ROLE lims_queue` when Atlas writes the revision, so `lims_queue` and `lims_reporting_lookup` need write access to the revisions table too (`permission denied for schema migrations_meta`, 42501, reproduced on the host).
Proposed change: put the `migrations_meta` schema, its default privileges and the extra grants into `db/bootstrap/01_database.sql` (night6 appended the exact statements; see patch) and keep dev glue consistent with it.
Backward compatible? yes.

### 5. Worker image cannot load `@lims/shared-ts`  (To: C0-0D / owner of `services/worker`) (reported)
Problem: the worker image built from `services/worker/Dockerfile` fails at runtime loading `@lims/shared-ts` (registry-sync imports every job module, one of which imports `@lims/shared-ts/spreadsheet`). Night6 rebuilt it with a `packages/shared-ts/dist` build stage and pushed it as `lims/worker:r2`; the broken `r1` is also in the registry.
Proposed change: build `packages/shared-ts` in the worker (and migrator) Dockerfile before copying `packages/`, then add a CI smoke step that starts each image and loads its entry point.
Backward compatible? yes.

### 6. Image smoke tests are missing for the build list  (To: C1) (reported)
Problem: three of the six app images built "successfully" while being unusable at run time (worker above; web and portal were missing runtime assets, fixed in 001). Nothing in the repo starts an image after building it.
Proposed change: add to `infra/ci/build.sh` (or a new `smoke-image.sh`) a read-only start check per image (`--read-only --tmpfs /tmp`, expect HTTP 200 or a clean entry-point load).
Backward compatible? yes.

### 7. First-release procedure and `push.sh` gaps  (To: C1) (reported)
Problem, found while pushing the first release with `infra/ci/push.sh`:
- Login is by `LIMS_REGISTRY_PUSH_USER` plus a password file (night6 added `docker login --password-stdin`); the repo had no login step (002 item 5).
- Third-party images must be mirrored by their linux/amd64 platform digest, not the index digest; resolving that digest needs the egress allowlist to include Docker Hub (done in the ops Squid role).
- `release-lock.sh` and the lock-to-`lims_runtime_images` writer (`lock-to-runtime-images.py`) work only in this order: build, retag `lims/<name>:r1`, push, mirror, lock, verify (every digest answers HTTP 200 on the registry manifests API).
Proposed change: take the night6 scripts (`lock-to-runtime-images.py`, `verify-lock.py`, `resolve-digest.py`, push.sh login change) into `infra/ci/` and document the order in `infra/README.md` ("First release").
Backward compatible? yes.

### 8. Lims firewall blocks `db_net` to the published DB ports  (To: C1, `roles/nftables`) (reported)
Problem: on a single host that is both `app` and `data`, traffic from the compose `db_net` to the published wg-IP DB ports (5432 / 6432) is dropped, so api/worker cannot reach pgbouncer when the runtime starts (night5 found it with a probe; night6 designed the fix and validated it with `nft -c -f` only; the live rules were not changed).
Proposed change: night6's "rule 5b" in `roles/nftables/templates/nftables.conf.j2`, only for hosts in both groups: accept `ip saddr <db_net>` with `ct original ip daddr <db_primary_wg_ip>`, tcp, `ct original proto-dst { 5432, 6432 }`, `ct state new`, placed after rule 5 and before the db_net drop. Open question: whether Docker's own bridge isolation also drops the packet; needs a test on a host.
Backward compatible? yes (additive, conditional).
Tenant/security impact: opens only the two DB ports from the compose network to the host's own wg address; no new public surface.

### 9. Monitoring play restarts ops-nginx to change basic-auth  (To: C1) (reported)
Problem: the new `ops_nginx_user/password` ids (002 item 5) take effect only through the Monitoring play, which restarts `ops-nginx`. There is no reload-only path, so changing the Grafana login always means an ops-nginx restart.
Proposed change: render the htpasswd to a bind-mounted file and `nginx -s reload` instead of restarting the container.
Backward compatible? yes.

### 10. `docs/` is not part of the deploy archive  (To: C1) (reported, low priority)
Problem: the archive used for the host contains no `docs/` directory, so docs referenced by the deploy (`docs/ops/PRODUCTION-BAR.md`, whose `push-cloud.ps1` reference is dangling, 002 item 8) cannot be edited or read on the deploy host. Night6 wrote `docs/ops/DAY-0.md` in the deploy copy only.
Proposed change: land `DAY-0.md` in the repo's `docs/ops/`, replace the `push-cloud.ps1` reference using the replacement text at the end of `DAY-0.md`, and include `docs/ops/` in the deploy archive.
Backward compatible? yes.

Tenant/security impact: none new beyond item 8. No PHI fields, no new public surface. No secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: keeping each fix only in the deploy copy on the host (done for the first deploy; not repeatable for a rebuild or DR).
Tests that will prove it:
- CI: all `#!` scripts under `infra/` and `tools/` are executable;
- CI: empty Postgres, apply all migrations through `db:migrate`, apply again = nothing to execute, `core.g_task_registry` populated after `worker:registry-sync`;
- CI: each of the six app images and the migrator starts read-only and loads its entry point;
- CI: `lock-to-runtime-images.py` refuses a missing key or a non-digest;
- host dry run on an empty single-host `prod-lean` inventory: nft rule 5b renders, passes `nft -c -f`, and an app container can reach pgbouncer.
