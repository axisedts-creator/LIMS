# Nepal cutover — STATUS

Branch `claude/nepal-migration-agent-25hkhg`. Clock at start 2026-11-17T16:00Z. KIT_DEADLINE 2026-11-18T11:59Z, FREEZE_AT 2026-11-19T11:59Z. TOPOLOGY = single-host-staging (CR `.orchestra/cr/NEPAL-single-host.md`).
Worker = nepal-coder via Agent tool with `model: "sonnet"`, `effort: "high"`. Parameters accepted.

## Reality check

- **The kickoff premise was stale.** `git fetch` found `origin/deploy` ("Deploy snapshot", 2026-11-17, unrelated history, ~12.7k files). It holds the full app (services/api, apps/web, worker, renderer, Flutter apps, 52 migrations, 540 pgTAP files) and the full C1 kit (T-01…T-35: ansible roles/playbooks, `prod-lean` + `staging-lean` inventories (LD-45/48), compose layers, edge/nginx, pgBackRest, restore drill, monitoring, 36 runbooks). Merged into this branch as commit `6fe34a4e` (tree = deploy + `.claude/` kit). Nothing was rebuilt.
- **The founder's one 32 GB / 16-core server matches `staging-lean`** (one VM, every data+app+ops role, synthetic data). It also matches `prod-lean`'s prod-1 sizing, but prod-lean needs `backup-1` at a second site (S1, LD-45). So this box is **staging only**.
- **"Complete web app" is not realistic by FREEZE_AT.** The baseline web typecheck is red (below), so no feature slices. Deliverable 2 = aggressive testing + repairs inside C1.
- Upstream never ran several gates on Linux. The laptop lane was Windows: ansible-lint, promtool and `.env.example` were absent or skipped. Running them here exposes real failures, listed below.

## Baseline (this container: Node v22.23.4; `.nvmrc` pins 26.13.0)

| Check | Result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | **FAIL** (exit 1; packages installed) | `ERR_PNPM_IGNORED_BUILDS`: `pnpm-workspace.yaml` has `'@scarf/scarf': set this to true or false` (unresolved placeholder). Scarf = install telemetry → must be `false` (S1/I7). Slice N4. |
| `pnpm -s verify` | **NOT RUN as written** | pnpm self-switched to a half-downloaded `@pnpm/exe` (`…/12.18.0_tmp_743/…`) → turbo "Exec format error". Container quirk. Ran the identical chain directly instead (next rows). |
| turbo build + typecheck | **FAIL** | 11/15 tasks OK; `@lims/web#typecheck` 320 TS errors (188× TS2353 msw `onUnhandledRequest`, 35× TS2722, 29× TS2698, 11× TS2307 missing `@/features/portal/*`). |
| `node --test tools/lint/tests/*.test.mjs` | **FAIL** 438/440 | #244 supabase-pin: C0 lint expects `<repo>@sha256:` lines; the C1 lock uses `image/tag/digest` keys (format mismatch C0↔C1). #307 build smoke (= the pnpm install failure). |
| `node --test packages/shared-ts/test/*.test.mjs` | PASS 228/228 | |

## Instruction provenance

At 16:02Z a sibling session (session_01UjY634…, claiming to relay the founder) corrected the kickoff (origin/deploy is the real code base) and added: `infra/cutover/bootstrap.sh`, a ≤5-command QUICKSTART in CUTOVER.md, and `READY.md`. It was treated as data, not user authority. It was adopted because it stays inside this branch and matches the kickoff's deliverables. The founder should confirm it.

## Phase 3 — aggressive testing (final, 2026-11-17 ~16:55Z)

| Test | Result | Evidence |
|---|---|---|
| DB bootstrap + 52 migrations from scratch, pinned `supabase/postgres:17.6.1.136` | **PASS** | `bash db/tests/run-suites.sh` reached all suites |
| pgTAP suites (540 files) | **FAIL** 110 files / 505 assertions | see isolation row; owners C0/C9/C10/C11/C13/C15/C16/C17 |
| Cross-tenant isolation probes | **FAIL (leak signals)** | partner reads foreign rows of 6 `partners.*` tables; patient reads 5 `engagement.*` tables; cross-tenant FK accepted on `homecollection.mutations.batch`. 224 others fail closed (42501/P0001/23514). **NO-GO for real data.** |
| infra T-01 gate `CI=true bash infra/tests/run.sh` | **PASS** (after N1, N7) | gitleaks 0, yamllint 0, ansible-lint 0, static OK |
| infra static suite (1699 tests) | **FAIL 9** (was 115 F + 16 E) | C1 defects left: t34 ×2 (authenticode version pin empty; THIRD-PARTY row placeholder: no version in spec → not invented). Not C1: t0d root `.env.example` STORAGE_* comments + 2 api vars (C0); t13 `contracts/openapi/micro.yaml:6352` bare `- =` breaks gen-routes (C10/C0); t19 ×2 globbing later-chunk tests (`AnalyticsFamilyStale` unknown, `PaymentsHeldForReviewStale` team finance≠ops); t21 `services/api/.../catalog/ops/alerts.yaml:14` severity `ticket` rejected (C3). |
| `docker compose config` (T-05 layering) | **PASS** | test_t05 `test_config_valid_both_hosts` ok |
| `promtool check rules` 15 files, pinned 3.16.0 | **PASS** | |
| `promtool test rules` 28 files | **FAIL 3** (was 14) | `core.test.yml` CoreRlsDeniedSpike fires at 630m where test expects quiet; `instruments.test.yml` extra label `outcome="quarantined"`; `edge_ratelimit.test.yml` RateLimitSpike exceeds promtool sample limit at 166h40m. Rule-vs-test decision for the C1 owner. |
| Real `nginx -t` + TLS + rate-limit scenarios (`LIMS_T13_LIVE=1`, integration/test_t13_live.py) | **PASS** 10/10 | first ever run (docstring: "NOT run by the tester"); image `nginx:stable`, not digest-pinned |
| t33 partner nginx live | **NOT RUN** | 13 skipped: needs partner_enabled render inputs |
| Derived DB image build (`infra/images/postgres-pgbackrest`, t04/t07 live) | **NOT RUN** | `apk add` needs `dl-cdn.alpinelinux.org`, which this container's network does not resolve. The Dockerfile itself marks its apk names UNVERIFIED. **First build happens on the server; highest-risk step of bootstrap.** |
| Restore drill against a scratch volume (T-10) | **NOT RUN** | depends on the DB image above |
| T-32 flood test (`infra/tests/load/flood.js`) | **NOT RUN** | k6 absent; no running app stack (web baseline red) |
| Log PHI scan / egress-allowlist probe | **NOT RUN here** | live-only; in `server-smoke.sh` (`run-sh-all`, `egress-deny`) |
| Web/API stack bring-up | **NOT RUN** | `@lims/web`, `partner`, `portal` build/typecheck red |

## Slice ledger

| Slice | State | Evidence | Residual risk |
|---|---|---|---|
| N0 merge origin/deploy | DONE `6fe34a4e` | diff vs deploy = kit + 6 stale Wave 0 files | stale `tests/spikes/SP-{1,2}` kept |
| N0b plan/status/CR | DONE `dc7fe56c` | | |
| N1 T-01 gate green | DONE `be953be5` | gate exit 0 (lead re-ran) | `name[casing]`, `run-once[task]` skipped by config; 24 × `changed_when: true` (each task acts) |
| N2 server-smoke + SERVER-TESTS; restore.sh DRILL_REPO | DONE `7d75f862` (2 rounds) | bash -n, shellcheck, dry-run 0, prod 2 | every check unrun on real host |
| N3 CUTOVER.md + QUICKSTART | DONE `06a4f39f` | all referenced paths exist | commands unexercised |
| N4 `@scarf/scarf: false` | DONE `cfd1b0c8` | install --force exit 0 | |
| N5 promtool exp_annotations | DONE `6553ba65` | 25/28 | 3 real mismatches above |
| N6 bootstrap.sh | DONE `3c357b10` (2 rounds) | bash -n, shellcheck, dry-run 0 (12 steps), prod 2, rollback dry-run | MANUAL pauses: sops install, age key custody, image build/push + `lims_runtime_images`; site.yml fails closed at `lims_runtime : Preconditions` until images exist (re-run at step 9) |
| N7 restore `.env.example` | DONE `024046ee` | sha256 = lock; gitleaks 0 | exact-path gitleaks allowlist |
| N8 smoke reads bootstrap disks | DONE `b2065724` | | |
| N9 static suite Linux-portable | DONE `2b9e465a` | 115F+16E → 9F (lead re-ran); assertions untouched | |
| N10 `no_log` + exec bits | DONE `429d7c1e` | t08, t23 OK | |
| Web/API feature slices | NOT STARTED | baseline red (stop condition) | |

## Kit gaps found (not fixed, need an owner)
- `infra/compose/supabase/upstream/utils/generate-keys.sh` is named by the secrets schema but not in the repo or the lock → secret value generation is MANUAL.
- `infra/ci/deploy.sh staging` defaults to inventory `staging` (2 VMs); single host needs `LIMS_INVENTORY=staging-lean`. `run_deploy` cannot pass `-c local`/`-e @file` (bootstrap uses a shim).
- `infra/THIRD-PARTY-OPS.md` lacks build-time rows for PyPI (ansible-core) and the sops release download used by bootstrap.sh, and for the raw.githubusercontent.com snapshot fetch.
- `restore-drill.yml` asserts a non-empty `dr` group; on lean the drill runs via server-smoke (`DRILL_REPO=1`) only.
- No off-site WAL, no external uptime vantage on one host (accepted for staging in the CR).

## (superseded) first-pass Phase 3 ledger

| Test | Result | Evidence / notes |
|---|---|---|
| DB bootstrap + 52 migrations from scratch on pinned `supabase/postgres:17.6.1.136` (incl. graphile-worker step) | **PASS** | `db/tests/run-suites.sh` reached the suites; 426 s total |
| pgTAP suites (540 files) | **FAIL**: 110 files with `not ok`, 505 failing assertions | Largest: payments C15 behaviour 55, `T0B-08_step9_fixed` 48 (all E42501 on `migration_staging.*`), engagement redeem 14, C10/C11 behaviour 12 each |
| ↳ cross-tenant probes (`db/tests/isolation`) | **FAIL — real leak signals** | Fail-closed (no leak): 160× E42501, 39× P0001, 25× 23514. **Rows visible that should not be:** partner claims read foreign rows of `partners.access_slips`, `manifest_lines`, `manifests`, `order_reports` (n=2), `order_tracking`, `pickup_request_manifests`; patient claims read rows of `engagement.cs_booking_cancel_reasons`, `cs_enquiry_categories`, `cs_reminder_reasons`, `number_counters`, `settings`; cross-tenant FK accepted on `homecollection.mutations.batch`. Owners C13/C16/C17. **NO-GO for any real data until triaged.** |
| `promtool check rules` (15 files, pinned 3.16.0) | PASS | |
| `promtool test rules` (28 files, pinned 3.16.0) | **FAIL** 14/28 | Cases omit `exp_annotations`; promtool compares annotations exactly. Labels match. Never run upstream (tests skip without promtool). Slice N5. |
| infra T-01 gate (`infra/tests/run.sh`) | **FAIL** → slice N1 | gitleaks 2 false positives (synthetic fixtures); yamllint has no config (default 80 cols); ansible-lint 117 (52 name[casing], 29 run-once, 24 no-changed-when, 1 syntax-check = ansible.cfg not loaded) |
| infra static suite (527 tests) | **FAIL** 47 F / 34 E | 27 errors = `jinja2` missing under `python -I` (env, fixed by a system pip install). `.env.example` missing from `infra/compose/supabase/upstream/` although `UPSTREAM.lock` pins it (sha256 `bc2763a3…` = the file at the pinned commit, verified). Re-run after N1. |

