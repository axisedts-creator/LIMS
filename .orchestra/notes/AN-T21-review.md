APPROVE

Reviewed `git diff 1b811ecd..HEAD`. The diff has 13 probe files, 1 handler change and 3 notes.
- Ownership: the probes sit under `services/api/src/modules/analytics/__tests__/probes/**`. The handler fix in `handlers/exports.ts` is outside the task file list but inside the C8-owned api `analytics` module. The tester asked for it in `AN-T21-tests.md`, and it matches 07-SECURITY P1.
- Handler fix: `assertFilterIdsKnown` uses the existing `labels.service` (same rule as `pending.service` `checkKnown`). It runs after authorise/periodAndScope and before quota/insert. Unknown or other-tenant ids return `common.not_found` and the id is not echoed. The shape is guaranteed by the OpenAPI `filters` schema (uuid arrays, additionalProperties false).
- §5 coverage: P1–P7, P9–P13 and X1–X3 run here. E1–E9, S1–S4 and P8 belong to AN-T10/T15/T16/T22 tests, and `coverage.probe` fails if those tests lose an ID. P12 is covered by the static policy guard (AND conjunct) plus all 30 ops × partner/portal/patient with zero reads. P13 is covered by the contract, the registry, a source grep and runtime checks with the flag off and on, including `sort=-net_billed_paisa` -> 400.
- RLS checks: ENABLE+FORCE on 26 tables, tenant predicate from `app.current_tenant_id()`, `::uuid[]` centre cast, system-only writes, no DELETE grant for class M, expiry-gated purge.
- No PHI, secrets or invented names found.
- Checks run: probe suite 11 files, 581 pass / 28 skip / 0 fail. `tsc --noEmit` shows no analytics errors.
- Not verified: live-PG pgTAP (no DB here). P6/P7/P12 SQL checks are static parses only, so live enforcement still depends on C0 `db/tests/isolation/analytics.*`.
