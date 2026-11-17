APPROVE
# T0D-03 review (reviewer)
- Diff c0e7c9bd..HEAD: `core/db/{tx,sqlstate,allowlists}.ts`, tests, `core/config.ts` (owned by C0-0D: 01-CHUNK-MAP `services/api/src/core/`). No foreign paths.
- §6.4: opening SQL verbatim (6 tx-local set_config + `now() AS tx_started_at`), defaults 5000/3000, UA cut to 512; SAVEPOINT s<n>/RELEASE/ROLLBACK TO; retry 40001/40P01 up to `LIMS_CORE_TX_RETRY_MAX` (3) with 10–50 ms jitter; `noRetry` request-level, gives 503 `common.dependency_unavailable` (AC-0D-2.7). Mapping table rows all match, incl. `lims_rls_denied_total` and `unmapped_unique_violation{constraint}`; mapped errors carry only the registry code (REQ-SEC-026).
- D-212: the 15 operationIds are verbatim; claims fixed to `{sub, actor_type:'system'}`; refused before any SQL; `bindTenant` once, then `common.internal`; `authzGuardExempt` on `x-context: identity_auth`. D-214: the 13 operationIds are verbatim; identity + platform only; claims restored afterwards; forged/nested/closed tx refused.
- Config keys match 02-TRD §11 (`LIMS_CORE_TX_RETRY_MAX`, `_IDENTITY_AUTH_OPS`, `_WITH_TENANT_SCOPE_OPS`). No secrets, no PHI in logs. No RLS DDL in scope.
- Ran: verify cmd 163/163 pass; `tsc --noEmit` clean.
- Not blocking (deferred, noted by writer): ctx.db/ctx.noRetry wiring, the access-log row per withTenantScope (C2), the core-internal withTenantScope uses (T0D-08/worker), real PgBouncer proof (SP-9).
