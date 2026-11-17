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

## Phase 3 — aggressive testing (running ledger)

| Test | Result | Evidence / notes |
|---|---|---|
| DB bootstrap + 52 migrations from scratch on pinned `supabase/postgres:17.6.1.136` (incl. graphile-worker step) | **PASS** | `db/tests/run-suites.sh` reached the suites; 426 s total |
| pgTAP suites (540 files) | **FAIL**: 110 files with `not ok`, 505 failing assertions | Largest: payments C15 behaviour 55, `T0B-08_step9_fixed` 48 (all E42501 on `migration_staging.*`), engagement redeem 14, C10/C11 behaviour 12 each |
| ↳ cross-tenant probes (`db/tests/isolation`) | **FAIL — real leak signals** | Fail-closed (no leak): 160× E42501, 39× P0001, 25× 23514. **Rows visible that should not be:** partner claims read foreign rows of `partners.access_slips`, `manifest_lines`, `manifests`, `order_reports` (n=2), `order_tracking`, `pickup_request_manifests`; patient claims read rows of `engagement.cs_booking_cancel_reasons`, `cs_enquiry_categories`, `cs_reminder_reasons`, `number_counters`, `settings`; cross-tenant FK accepted on `homecollection.mutations.batch`. Owners C13/C16/C17. **NO-GO for any real data until triaged.** |
| `promtool check rules` (15 files, pinned 3.16.0) | PASS | |
| `promtool test rules` (28 files, pinned 3.16.0) | **FAIL** 14/28 | Cases omit `exp_annotations`; promtool compares annotations exactly. Labels match. Never run upstream (tests skip without promtool). Slice N5. |
| infra T-01 gate (`infra/tests/run.sh`) | **FAIL** → slice N1 | gitleaks 2 false positives (synthetic fixtures); yamllint has no config (default 80 cols); ansible-lint 117 (52 name[casing], 29 run-once, 24 no-changed-when, 1 syntax-check = ansible.cfg not loaded) |
| infra static suite (527 tests) | **FAIL** 47 F / 34 E | 27 errors = `jinja2` missing under `python -I` (env, fixed by a system pip install). `.env.example` missing from `infra/compose/supabase/upstream/` although `UPSTREAM.lock` pins it (sha256 `bc2763a3…` = the file at the pinned commit, verified). Re-run after N1. |

## Slice ledger

| Slice | State | Evidence | Residual risk |
|---|---|---|---|
| N0 merge origin/deploy | DONE `6fe34a4e` | `git diff --stat origin/deploy HEAD` = 11 files (kit + 6 stale Wave 0 notes/spikes) | stale `tests/spikes/SP-{1,2}.decision.test.mjs` kept from Wave 0 |
| N1 T-01 gate | IN PROGRESS | | |
| N2 server-smoke + SERVER-TESTS | IN PROGRESS | | |
