CHANGES

Scope note: `git diff d3d5809..HEAD` is empty (HEAD == d3d5809); BL-T01 work was committed before that base. Reviewed the five task files plus `services/api/src/modules/billing/__tests__/unit/boot.test.ts` as committed.

1. services/api/src/modules/billing/__tests__/unit/boot.test.ts:74 — the boot test ("core boots with module", the only done_when) fails with `Error: Test timed out in 5000ms.`. A full `bootstrap()` over the real contracts plus injecting every billing operation takes about 10.5 s here. Fix: give the `it(...)` an explicit timeout the way the sibling C4 test does (frontdesk boot.test.ts:89 `}, 60_000);`). Change line 74 from `  });` to `  }, 60_000);`. Verified: with `--testTimeout=60000`, all 9 tests pass (10.35 s). Assertions unchanged.

Checked, no defect:
- permissions.ts: all 14 codes are verbatim from contracts/permissions.yaml (the full billing.* set).
- nav.manifest.ts: `staff.billing.daily_cash` / `billing.cash_report.read` match contracts/routes.yaml:18.
- config.ts: keys and defaults match C4 02-TRD §11.1 (lines 578-582). `live` is refused. Config loads lazily, so import does not throw.
- index.ts: produces exactly the three billing events. No ports are declared. Every handler maps to a billing.yaml operation.
- worker index.ts: empty manifest. Worker and web tests pass (2 files, 7 tests).
- No RLS, migrations or DB access in this task. No secrets (the test JWT key is a synthetic tmp file). Request logs carry only ids, routes and codes, no PHI. All paths are C4-owned.
- Non-blocking, not in BL-T01: the uncommitted `pnpm-workspace.yaml` line `'@scarf/scarf': set this to true or false` is invalid as a value and sits outside C4 ownership. Revert it rather than commit it.
