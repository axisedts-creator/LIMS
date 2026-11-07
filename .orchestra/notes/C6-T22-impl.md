# C6-T22 impl (writer)
Files: handlers/verify.handlers.ts, service/verify.service.ts, repository/verify.repo.ts (new); index.ts (wires verifyHandlers).
Tests: verify.{handlers,revoke,static}: 104 pass / 2 fail — both are test bugs (`undefined` body hits a default param), see C6-T22-dispute.md.
[CONV] Q1: limiter `qr_verify` key `i:<clientIp>` first (misses + malformed count), regex in service, ONE stmt `app.reporting_verify_qr($1)` with 32-byte sha256, single error `reporting.verify_not_found`; missing tx/rateLimit/clientIp -> common.internal.
[CONV] R14/R16: user actors only (portal -> auth.forbidden); reason via listCodes(token_revoke_reasons), `other` needs text; first revoker wins (UPDATE ... revoked_at IS NULL), replay/race = 200 with ORIGINAL revoked_at, audit only on the winning write.
[CONV] R16 stores no reason_text (portal_links has no such column); R15 omits null optionals, <= 200 rows, 404 for unknown / other-tenant report.
Open: R16 does not end live portal sessions (resolver re-checks portal_links, so they fail on next use); real PG/RLS/DEFINER/timing not exercised here.
