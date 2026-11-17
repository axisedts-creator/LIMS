# READY? — one screen

**Verdict: NOT-READY for "five commands and done".** The kit is reviewed and its in-repo checks are green, but nothing has run on the real server. The bootstrap pauses for 3 manual steps, and the DB image has never been built (blocked here by network).
**Staging, synthetic data only.** One host cannot hold PHI (04 S1; CR `.orchestra/cr/NEPAL-single-host.md`).

## The 5 commands (fresh Ubuntu LTS, 16 cores / 32 GB)
```bash
git clone --branch claude/nepal-migration-agent-25hkhg <repo-url> lims && cd lims
sudo bash infra/cutover/bootstrap.sh --dry-run        # prechecks + plan, changes nothing
sudo bash infra/cutover/bootstrap.sh                  # asks disks/domain/e-mail/age custody once, then builds
sudo LIMS_ENV=staging bash infra/cutover/server-smoke.sh   # exit code = number of FAILs
sudo bash infra/cutover/bootstrap.sh --rollback       # undo
```
Full runbook: `infra/cutover/CUTOVER.md`. Server-only tests: `infra/cutover/SERVER-TESTS.md`.

## Ready (verified in the cloud container)
- infra gate `CI=true bash infra/tests/run.sh`: PASS (gitleaks, yamllint, ansible-lint, static)
- DB bootstrap + all 52 migrations from scratch on the pinned Postgres image: PASS
- real `nginx -t` + TLS + edge rate limits (test_t13_live): PASS 10/10
- `docker compose config` layering, `promtool check rules`: PASS
- bootstrap.sh / server-smoke.sh: syntax, shellcheck, dry-run, refuse-non-staging: PASS

## NOT tested / failing
- **Everything on the real host:** LUKS, wg0, fio IOPS, PgBouncer, pgBackRest, restore drill, TLS issuance, egress denies.
- **DB image build:** NOT RUN (Alpine CDN blocked here; apk names marked UNVERIFIED in the Dockerfile).
- **bootstrap MANUAL pauses:** sops install, age key custody, app image build/push (`lims_runtime_images`). Supabase `generate-keys.sh` is not in the repo.
- **Isolation probes:** FAIL, with cross-tenant leak signals (partners, engagement, homecollection). **No real data.**
- **Web app:** typecheck/build FAIL (320 TS errors), so no app features were built and no flood test was run.
- promtool tests 3/28 FAIL; infra static 9/1699 FAIL (details in STATUS.md).

## Do first
1. Record the disk by-id names and run `bootstrap.sh --dry-run` on the box. Send back its output.
2. Assign owners for the isolation-probe failures (C13/C16/C17) before any real tenant.
3. Confirm the scope additions relayed by the sibling session (bootstrap.sh, QUICKSTART, READY.md).
