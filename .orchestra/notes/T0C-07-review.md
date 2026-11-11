APPROVE

Reviewed `d07bdfa..HEAD` (T0C-07 impl) against 03-IC §4, 08 R9, A19 (P-40, D-100, D-110, D-111), A21.2, A22.0, A24.1, PRD AC-0C-3.1–3.4.

Checks run
- `pnpm --filter @lims/fakes test` → 4 files, 458 passed, 37 skipped (non-phase1Stub cases on stub runs), 0 failed.
- Phase stubs match 08 R9 table verbatim (Quality deny/[feature_disabled] + no_qc_data; SmartReport `smartreport.feature_disabled`; PaymentProvider all 5 methods `payments.gateway_not_available`; Engagement undefined / `common.not_found`). No data, no seeding, no failNext.
- P-40/A22.0 grammar `^[A-Za-z0-9_.:-]{1,200}$` exact (base.ts:44), applied before replay lookup.
- D-100 optional `expectedVersion` (IdentityPort.fake.ts:186) + case (13); A21.2 system-only `readSignatureImage`, not_found; A24.1 status set follows contracts/ports/CatalogPort.ts:132 (C3 set incl. `discarded`); D-111 never throws `summary_not_ready`, unapproved → `draft`; D-110 C14 `lab_display` / C15 `getOrderSummary` cases present.
- Tenant isolation: every lookup keyed by `ctx.tenantId`; cross-tenant → `common.not_found` (AC-0C-3.4). Error codes used are registered names. No console/logging, no secrets, synthetic data only. Files only under packages/fakes (package.json/lockfile edits were requested by the tester brief).

Non-blocking notes (follow-ups, not defects of this task's files)
1. Type safety: `@lims/contracts` exports only `./ports/common` and `./ports/generated/error-codes` (contracts/package.json:5-8), so `tsc` cannot resolve `@lims/contracts/ports/<Port>` (18× TS2307) and every port type collapses to `any`; fakes are not type-checked against the IC interfaces. packages/fakes also has no tsconfig/`typecheck` script, so `turbo run typecheck` skips it. Fix belongs to the contracts package owner task: add `"./ports/*": "./ports/*.ts"` export, then add packages/fakes tsconfig + typecheck and clear TS7006s.
2. FrontdeskPort.contract.ts:168 asserts patient/portal actors get `auth.forbidden` on `getOrderSummary`. D-110 states C15 calls as staff/system; it does not state a refusal rule for all callers. No known consumer calls it as patient/partner, so harmless now, but the real C4 impl will be held to it — confirm with C4 or cite a source.
3. D-110 says names are omitted when a C14 caller lacks `lab.worklist.read`/`lab.status_board.read`; the fake refuses (`auth.forbidden`) per IC §4.3 allowlist wording. Consistent with IC; C14 must handle omission itself.
