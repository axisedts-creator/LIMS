Title: CR-C0-0D-FINCTRL-1: discount limit/authority user id the web can know; fiscal_year_label on getAccountStatement
From chunk: C0-0D            To owner: C0-0C (contracts) then C0-0B (handlers)
Type: api
Blocking? yes — T0D-FINCTRL-1 done_when (2) limits/authorities Add New and Edit (disabled with a visible reason until ruled) and done_when (6) ledger fiscal year filter.

ITEM 1 — user id for discount limits and authorities
Problem: setUserDiscountLimit (PUT /v1/billing/discount-limits/{user_id}) and createDiscountAuthority (POST /v1/billing/discount-authorities) key on user_id = core.users.id (services/api/src/modules/billing/repository/discountPolicy.repo.ts:96, discountPolicy.service.ts:272 userOrNotFound, frontdesk discountApprovals.repo.ts:58 `l.user_id = m.user_id`). The only member list the web has, the identity UserPage (contracts/openapi/identity.yaml:951), carries membership_id and no user id. The web therefore cannot send the id the API expects (common.not_found, or a row that never matches a requester) and cannot name the User of existing rows.
Proposed change (exact, pick one):
  A) identity.yaml UserPage item: add optional read-only `user_id: string (uuid)` = core.users.id. Additive.
  B) billing.yaml: setUserDiscountLimit path param and createDiscountAuthority body take `membership_id`; UserDiscountLimit and DiscountAuthority return `membership_id` beside `user_id`; server maps membership_id to user_id within the tenant. B changes path semantics, so it ships as a new operation per 04-CHANGE-REQUESTS §3.2.
Recommended: A (additive, owner may approve alone).
Backward compatible? A yes. B no unless versioned.
Tenant/security impact: A exposes core.users.id of members of the same tenant only (same RLS as UserPage); no PHI. B none beyond the tenant check.
IRD/regulatory impact: none (configuration of discount ceilings, no invoice change).
Alternatives considered: match on display name (unsafe); keep current membership id (wrong rows).
Tests that will prove it: web test that Add New on limits sends PUT /discount-limits/{core.users.id} and authorities POST body user_id = core.users.id for a member whose membership id differs; API test that the id resolves to the requester in discountApprovals.

ITEM 2 — fiscal year filter on the ledger statement
Problem: done_when (6) asks for a fiscal year filter on the ledger. getAccountStatement has no fiscal_year_label parameter (T0B-FINCTRL-1-impl.md:7 item 4 "CR NEEDED"); listAccountEntries already has one.
Proposed change (exact): billing.yaml getAccountStatement: add optional query parameter `fiscal_year_label` with the same schema/pattern as on listAccountEntries; when present the opening balance and rows are bounded to that fiscal year (Shrawan 1 BS start per LD-321 until the accountant confirms). Additive.
Backward compatible? yes.
Tenant/security impact: none (filter only, same RLS, held entries still excluded per LD-321).
IRD/regulatory impact: none (read only).
Alternatives considered: client side filtering of the statement (wrong opening balance).
Tests that will prove it: API test with entries in two fiscal years; web test that the ledger FY filter sends fiscal_year_label.
