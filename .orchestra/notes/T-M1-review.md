APPROVE
# T-M1 review (reviewer) — diff 7be5792a..452b2a03
Checked against 02-TRD §5 M1a–M5/E47 + §4.12, PRD US-EN-17.1–17.6, 07-SECURITY (aal1 row, "Membership card QR", access-log item 7), plan row T-M1, LD-140.
- Names verbatim: operationIds, permissions (membership.read / membership_plan.manage / membership.enrol / self.read), errors (engagement.membership_overlap, engagement.plan_inactive, common.validation_failed on price list), access-log code patient_membership.lookup, MembershipCard fields incl. profile_id = link id.
- Tenant isolation: every statement binds tenant_id; ANY($2::uuid[]) cast; worker task guards payload tenant == ctx tenant; no DELETE; no catalog.* / v_pub_* read (price list via CatalogPort.getPriceListStatus only).
- AuthZ before any query; plan write privileged -> auth.mfa_required at aal1 (tested). Idempotency for M2/M1b create is the core pipeline stage (web sends Idempotency-Key). If-Match on M1b update and M5.
- Secrets/PHI: card token 130-bit CSPRNG, unbiased Crockford; never logged/audited; web strips token from results; Flutter puts token only into QR (tested).
- Tests run by reviewer: api 102/102, worker 15/15, web 53/53, flutter 32/32 — all pass.
Non-blocking notes (no change required): unchanged price_list_id on plan update is not re-validated ([CONV] in impl note); lookup miss is not access-logged (no entity); A21 route + native brightness hook and web help key `engagement.memberships` remain open for their owners (impl note).
