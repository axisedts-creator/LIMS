# Nepal cutover — slice plan

Lead: nepal-migration (Opus). Worker: nepal-coder (Sonnet, high). KIT_DEADLINE 2026-11-18T11:59Z, FREEZE_AT 2026-11-19T11:59Z.
TOPOLOGY = single-host-staging → inventory `infra/ansible/inventories/staging-lean` only, synthetic data only (CR `.orchestra/cr/NEPAL-single-host.md`).

## Why this plan differs from the protocol's default order

The kickoff said the repo was a Wave 0 shell with no `infra/`. `git fetch` found `origin/deploy` ("Deploy snapshot", unrelated history, 2026-11-17), with the whole C1 kit: T-01…T-35 static tests, ansible roles and playbooks, `prod-lean`/`staging-lean` inventories (LD-45/LD-48), compose layers, edge, pgBackRest, drill, monitoring and runbooks. The protocol says to build on upstream work and never redo it. So commit `6fe34a4e` merges `origin/deploy` into this branch (tree = deploy plus the `.claude/` kit and 6 stale Wave 0 notes/spikes). Default slices T-01…T-14 are therefore **verify-and-repair**, not build.

## Deliverable 1 — server-build kit

| # | Slice | Plan task | Paths (owner) | done_when | Verify (runs here) | Spec |
|---|---|---|---|---|---|---|
| N0 | Merge upstream deploy snapshot | — | whole tree | tree = origin/deploy + kit | `git diff --stat origin/deploy HEAD` = kit files only | protocol Phase 0 |
| N1 | T-01 gate green in a clean Linux container | T-01 | `infra/**` (C1) | `CI=true bash infra/tests/run.sh` exit 0 | same, with gitleaks/shellcheck via docker wrappers | C1 06-PLAN T-01; 02-TRD §12.4 (l.950, l.1011) |
| N2 | Server-only tests + smoke script | T-30/T-31 subset | `infra/cutover/SERVER-TESTS.md`, `infra/cutover/server-smoke.sh` (C1) | script has `--dry-run` and refuses non-staging-lean; `bash -n` + shellcheck clean; dry-run prints every step | `bash -n`; `shellcheck`; `server-smoke.sh --dry-run` | C1 06-PLAN T-30, T-31; 04 I1, I3, I7 |
| N3 | Cutover runbook | T-31 subset | `infra/cutover/CUTOVER.md` (C1) | 9 sections of protocol Phase 4; every command exists in repo | grep every referenced path exists | C1 runbooks/dr.md, secrets.md; 04 I1, I3 |
| N4 | Deny `@scarf/scarf` install script (telemetry) | — (baseline repair) | `pnpm-workspace.yaml` (C0-0A) | `pnpm install --frozen-lockfile` exit 0 | same | 04 S1/I7 (no telemetry) |

## Deliverable 2 — app slices + hardening

Baseline `@lims/web` typecheck = **FAIL** (320 TS errors across many chunks: msw 3 `onUnhandledRequest` typing in tests, missing `@/features/portal/*` modules). Protocol stop condition: "Baseline cannot run and cannot be fixed → stop building web slices, finish the kit only". Repairing it means one slice per owning chunk (C6, C14, C16, …). That cannot be done safely before FREEZE_AT. **No web/API feature slices.** Deliverable 2 = Phase 3 aggressive testing only.

## Deferred (and why)
- All web/API feature tasks: baseline red (above).
- T-12 standby, T-29 DR promote: `dr: {}` is empty on a single host.
- T-11 object replica, repo2 WAL: needs `backup-1` at site B (B12).
- T-15, T-20…T-23, T-25…T-28, T-33…T-35: exist upstream with static tests. Re-verified only by the static suite; not reworked.
