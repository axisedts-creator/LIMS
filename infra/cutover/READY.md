# READY? — one screen (reissued 2026-11-18 ~02:20Z)

**Verdict: NOT-READY for "five commands and done".** The kit is reviewed, and every check this container can run passes or has a named owner. But nothing has run on the real server (it is built on 18 Nov). Two hard blockers sit outside this session: the Node base-image choice and `apps/portal/Dockerfile`. Without them `bootstrap.sh` step 8 (app images) cannot finish.
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
- `next build` for web, portal and partner
- real `nginx -t` + TLS + edge rate limits (test_t13_live 10/10); compose config; promtool check rules
- DB image apk package names (live Alpine 3.23 index)
- bootstrap.sh / server-smoke.sh: syntax, shellcheck, dry-run, refuse-non-staging

## Cross-tenant
Cycle 1's "leak signals" were **probe-generator bugs, not leaks** (lead verified the policy and spec text; CRs NEPAL-leak-C13/C16/C17 with patches for C0-0B). Other pgTAP files are still red and undiagnosed (CR-C1-902 item 8). **No real data.**

## Still FAIL / NOT RUN
- Web typecheck: **FAIL 2** (was 320). Both in unowned paths (CR-C1-901, patches attached).
- Lint #244 (C0 lint vs C1 lock format), #307 (container pnpm/turbo quirk); infra static 5/1704; promtool tests 3/28: owners in CR-C1-902.
- NOT RUN: DB image build (github.com blocked here; built on the server), every server-only check, restore drill, flood test.

## Do first
1. Founder: choose the Node 26.13.0 base image variant (CR NEPAL-node-base-image.md). C6: add `apps/portal/Dockerfile`.
2. On the new box: `bootstrap.sh --dry-run`, then send back its output.
3. C0-0A: owners for `apps/web/src/__tests__/**` and `features/webfix1/**`, then apply the 2 attached patches → typecheck green.
