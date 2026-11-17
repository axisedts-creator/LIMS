APPROVE

Scope: git diff f72737e5..HEAD (FD-T05 Quote F8).
- Names verbatim: route/op/permission `frontdesk.registration.create`, x-idempotency none, tier general, error codes (common.validation_failed, common.not_found, frontdesk.discount_exceeds_limit; catalog.* propagated unchanged per 08 R18) match contracts/openapi/frontdesk.yaml:657-681. Response fields match Quote/QuoteLine/Totals schemas (frontdesk.yaml:4368-4512); credit_status only in credit mode.
- Tenant isolation: no new table/SQL; only read is getSettings(c.tx, tenantId) via existing RLS repo. Centre scope -> 404. Ports receive ctx.
- No writes, no events, no logging, no secrets; validation errors carry fixed messages, nothing echoed.
- Owned paths only (frontdesk module + tests/frontdesk). Ruling FD-T05-ruling.md applied (quote.test.ts:74 uses world()).
- Tests cover done_when (fingerprint stable/base/changes; discount evaluation A/B tenants, abs max, 06.3) and ACs 05.1-2, 06.1-3, 14.1 quote half.
- Ran: quote.static.test.ts 8/8 pass; tsc 0 errors in modules/frontdesk. DB suite (FD-T05.pg.sh) not re-run by reviewer; writer reports 64/64.
Non-blocking notes: amount_paisa/percent_bp = 0 rejected though schema min is 0 (consistent with domain/discount.ts); duplicate orderable rejected ([CONV]); reason_code not checked against coded set frontdesk.discount_reasons (left to pipeline x-coded-set).
