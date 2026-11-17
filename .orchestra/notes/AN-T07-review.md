APPROVE

# AN-T07 review (reviewer)
- Diff 8586a01..HEAD: only owned paths (`modules/analytics/{repository,service}/**` + own notes). No spec/.orchestra edits beyond notes.
- Names verbatim: `catalog.v_pub_department`, `catalog.v_pub_test_directory`, `catalog.v_pub_referrer_directory` (+`canonical_referrer_id`, CR-C3-004), `instruments.v_pub_instrument_directory` (08 R12d). Selected columns are subsets of 03-IC §6 and match the DDL in `db/migrations/20261105001500_catalog__...sql:1528-1551` and `20261105002000_instruments__...sql:976-979`.
- Tenant isolation: tenant always bound `$1`, ids one bound array `= ANY($2)` (uuid type inferred from column); views are `security_invoker` so RLS of base tables applies. No new tables/policies in this task.
- Core access: `ctx.core.centres/branches(ctx, { activeOnly:false })` and `memberships.list(ctx, { membershipIds ≤200, activeOnly:false })` match `core/core-repo/index.ts:60,73,131` and 03-IC §13.5 D-47/P-17. No direct `core.*` reads.
- Permissions / idempotency / rate tier / error codes: n/a (no handler; AN-T08+). Errors propagate unchanged; no new codes.
- No PHI, no logging, no secrets. REQ-SEC-081 explicit column allowlists; entry objects expose only allowlisted fields.
- Ran: verify cmd vitest -> 2 files, 60/60 pass; `tsc --noEmit` -> 0 errors in labels files.
- Non-blocking: tests use a fixture-backed fake tx, not a live DB (live infra exists, e.g. `billing/repository/__tests__/immutability.live.test.ts`). Column names manually verified against migrations above; a `labels.repo.live.test.ts` would be a cheap follow-up. `canonical_referrer_id` is coalesced in the DDL, so the service `?? referrer_id` fallback is redundant but harmless.
