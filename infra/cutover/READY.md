# READY? — one screen (reissued 2026-11-18 ~03:10Z, final for this session)

**Open DB-security items — founder/owner decision needed before ANY real data (CR `.orchestra/cr/NEPAL-pgtap-triage.md`; no confirmed cross-tenant leak, but these are not cleared):**
- **(a?) D1: `device` actors pass `app.is_staff_or_system()` on 249 tables, including read/insert/update on payments (C15), 9 anatomic tables (C11) and quality.qc_plans (C9). 08 A19.1 accepted this; the C9/C11/C15 suites expect 0. Decide: keep A19.1, or extend D-109 to these tables.**
- **(a?) D2: 18 class-C tables writable by lims_app have no BEFORE UPDATE guard (anatomic ×8, billing ×2, frontdesk ×1, lab ×6, payments ×1).**
- **(a?) D3: three smartreport CHECKs accept NULL (rules__followup_fields__ck, summaries__score__ck, library_versions__hash__ck).**
- **(a?) D4: SECURITY DEFINER `app.identity_login_context(uuid)` has no claims guard and is EXECUTE for lims_worker (migration 20261116040000).**
- **(c) C1: identity DEFINER suites and the storage suite abort on stale fixtures before asserting (T0B-06_definers, AUTH-PLATFORM-SESSION-1, T-L2_redeem_link_code, PLATFORM-DDL-1, T0B-12_storage). Untested, so not cleared.**
- **(c) C2: migration_staging RLS has never run as lims_migration (role lacks lims_app membership, D-136 undecided).**

**Verdict: NOT-READY for "five commands and done".** The kit is reviewed, and every check this container can run passes or has a named owner. But nothing has run on the real server (it is built on 18 Nov). Remaining hard inputs: the founder confirms the Node base image on the server (bootstrap step 8 resolves the digest; default shown `node:26.13.0-bookworm-slim`), and the server must reach github.com and the Alpine CDN to build the DB image.
**Staging, synthetic data only.** One host cannot hold PHI (04 S1; CR `.orchestra/cr/NEPAL-single-host.md`).

## The 5 commands (fresh Ubuntu LTS, 16 cores / 32 GB)
```bash
git clone --branch claude/nepal-migration-agent-25hkhg <repo-url> lims && cd lims
sudo bash infra/cutover/bootstrap.sh --dry-run        # prechecks (incl. github.com + Alpine CDN reachable) + plan
sudo bash infra/cutover/bootstrap.sh                  # asks disks/domain/e-mail/age custody once, then builds
sudo LIMS_ENV=staging bash infra/cutover/server-smoke.sh   # exit code = number of FAILs
sudo bash infra/cutover/bootstrap.sh --rollback       # undo
```
Pauses left inside bootstrap: sops install (skipped if you export `LIMS_SOPS_SHA256` + `LIMS_SOPS_URL`), age key custody (by design), app image build/push.

## Verified here (PASS)
- infra gate `CI=true bash infra/tests/run.sh` (gitleaks, yamllint, ansible-lint, static)
- DB bootstrap + all 52 migrations from scratch on the pinned Postgres image
- `next build` for web, portal and partner; **web and portal images build from a clean checkout and serve HTTP (307/200) on a read-only rootfs** (web start-up crash found and fixed, W4)
- real `nginx -t` + TLS + edge rate limits (test_t13_live 10/10); compose config; promtool check rules
- DB image apk package names (live Alpine 3.23 index)
- bootstrap.sh / server-smoke.sh: syntax, shellcheck, dry-run, refuse-non-staging

## Cross-tenant
Cycle 1's "leak signals" were **probe-generator bugs, not leaks** (lead verified the policy and spec text; CRs NEPAL-leak-C13/C16/C17 with patches for C0-0B). The other red pgTAP files are now triaged: 446 assertions fail closed (b), with fixes in the CR. The (a?)/(c) items are listed above. **No real data.**

## Still FAIL / NOT RUN
- Web typecheck: **FAIL 2** (was 320). Both in unowned paths (CR-C1-901, patches attached).
- Lint #244 (C0 lint vs C1 lock format), #307 (container pnpm/turbo quirk); infra static 5/1704; promtool tests 3/28: owners in CR-C1-902.
- NOT RUN: DB image build (github.com blocked here; built on the server), every server-only check, restore drill, flood test.

## Do first
1. Founder: decide D1–D4 and D-136 above. C6: review the new `apps/portal/Dockerfile`.
2. On the new box: `bootstrap.sh --dry-run`, then send back its output.
3. C0-0A: owners for `apps/web/src/__tests__/**` and `features/webfix1/**`, then apply the 2 attached patches → typecheck green.
