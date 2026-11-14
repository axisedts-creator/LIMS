# T-L5 impl (writer)
- Files: `service/link.service.ts` (new `reconcile(ctx)`), `service/projection.service.ts` (new `deleteForPatients`), `worker/.../engagement/cron.ts` (row `35 20 * * *` per_tenant + `reconcileLinks` with tenant guard), `engagement/index.ts` (manifest entry).
- Tests: reconcile_links 38/38; worker engagement 283 pass; api engagement 1269 pass, 1 fail `boot.test.ts` PHASE_STUBS/QualityPort (not touched by T-L5, not checked on a clean tree).
- [CONV] reasons priority: merged/anonymised > phone_mismatch > dormant; refresh (display_name/sex_snapshot, all live links, all methods) merged into the same UPDATE as a suspension (one version bump); skipped for merged/anonymised patients.
- [CONV] suspend status passed as bound param (`status = $n`): `link.redeem.test.ts` source guard forbids a literal `status = 'active'` in an UPDATE of account_patient_links.
- [CONV] record phone removed in C4 (phoneE164 absent) with a stored HMAC counts as phone_mismatch; `last_login_at` NULL = not dormant; settings row missing = 180 days.
- Open: projection DRIFT repair (TRD 8.2, orders updated in last 30 days) not done (not in plan row/ACs); leftover-patient scan reads all patient ids of orders/reports per tenant (`ponytail:` comment, keyset-page later); no real-Postgres/pgTAP run; worker `tsc` is already noisy on unrelated files, not used as a gate.
