APPROVE

T-EP1 review (diff 5c26b99c..HEAD).
- Signatures, permission codes (homecollection.visit.assign / .read, frontdesk.registration.create) and error codes (common.not_found, auth.forbidden, common.validation_failed) are copied verbatim from IC §4.17 / TRD §6.1. Read-only single-table SELECTs; each binds tenant_id = ctx.tenantId on top of RLS (REQ-SEC-024). No v_pub_* reads (R25 / P-21). Nothing is logged and no access_log is written; the caller writes it, as IC §4.17 says.
- Device/patient actors get auth.forbidden before any read. Staff go through IdentityPort.assertRole. A system actor passes, matching the "System actors" wording in the IC.
- Membership filter: status = 'active' and valid_from <= at < valid_to. price_list_id is NOT NULL in 05-SCHEMA, so returning it is never null.
- Tests: the full contract run covers cases 1–3, plus both ACs, tenant binding with an RLS bypass, minimal exposure and no PHI in logs. The phase1Stub retirement follows T-EP1-ruling.md. Ran: vitest EngagementPort* 29/29 passed. tsc shows no errors in engagement/; the remaining errors are in contracts/ports/common.ts and shared-ts, which this diff does not touch.
- Only owned paths changed (module files plus .orchestra/notes).
- Not a defect, noted for follow-up: the impl adds validation (purpose must be 'home_visit', uuid format) that returns common.validation_failed. The IC does not list that error but types purpose as a literal, so the check is consistent with it.
