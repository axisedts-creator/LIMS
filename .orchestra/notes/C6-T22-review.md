APPROVE

Reviewed `git diff d04e9d80..HEAD` (verify.handlers.ts, verify.service.ts, verify.repo.ts, index.ts wiring, 3 test files).
- Names verbatim: operationIds verifyReportQr/revokeReportQrToken/listPortalLinks/revokePortalLink (02-TRD §6.2/6.4), tier `qr_verify` keyed on ctx.clientIp (08 A13 D-32/A25 P-61), `reporting.verify_not_found`, coded set `token_revoke_reasons`, access action `report.token_revoke` (IC 3265), `app.reporting_verify_qr(bytea)` matches migration RETURNS TABLE columns.
- Q1: limiter first, regex `^[A-Za-z0-9_-]{22}$` in handler, only SHA-256 to DB via DEFINER, single 404 for all failure classes; fails closed without tx/rateLimit/clientIp.
- Tenant isolation: every R14-R16 statement carries `tenant_id = $1`; Q1 reads only through the DEFINER (REQ-SEC-018). No new tables/RLS in this diff.
- Revoke: write-once (`revoked_at IS NULL`), only revoked_*/reason columns updated (allowed by enforce_mutable_columns); R16 writes no reason_text (portal_links has none). No PHI/secrets in logs or audit detail (reason_code only).
- Paths: only modules/reporting/** (owned). Tests: 106/106 pass (vitest run 2026-11-08 03:18).
Non-blocking notes: (1) audit.access rows omit `centreId` though qr_tokens/portal_links carry centre_id (siblings pass it) — consider adding for centre-scoped audit views. (2) Spec gaps the tester listed (malformed tokens consuming qr_verify budget; re-revoke = 200 original revoked_at; R16 vs live portal sessions) are [CONV] and should go to the lead. (3) manifest.test.ts 501-stub list still includes Q1/R14/R15/R16 — tester must update. Real PG/RLS/timing not exercised here.
