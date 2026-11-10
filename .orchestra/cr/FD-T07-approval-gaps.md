Title: CR-C4-FD-T07-001: F15 has no gross for the absolute-max check / approval display fields
From chunk: C4            To owner: C4 (doc owner: founder) — 02-TRD F15 row, 03-APP-FLOW §discount approval
Type: api
Blocking? no (FD-T07 implemented and tested; F9 still enforces the absolute max on the real quote)
Problem: 02-TRD:208 lists `frontdesk.discount_exceeds_limit` (above absolute max) for F15 and 03-APP-FLOW:30 says approval applies when the computed discount is "> self-limit and <= absolute max", but the F15 body (`{centre_id, base_fingerprint, discounts[], reason_code, reason_text?, patient_ref}`) carries no lines and no gross, and `base_fingerprint` is a one-way hash. The server cannot compute `computed_discount` / `percent_of_gross_bp` / `gross_paisa` (05-SCHEMA discount_approvals) or raise the 422. Today ([CONV], discount.service.ts header): `gross_paisa = 0`, `computed_discount_paisa` = sum of amount-kind discounts, `percent_of_gross_bp` = summed percent-kind bp; no 422 at F15. Serves US-FD-07.1 (approver sees what they approve), US-FD-07.2.
Proposed change (exact): pick one — (a) F15 body += `lines[]` (same shape as RegistrationDraft lines); server re-quotes via CatalogPort, checks the recomputed base_fingerprint equals the sent one, fills gross/computed/percent and raises 422 above `discount_absolute_max_bp`; or (b) drop `frontdesk.discount_exceeds_limit` from the F15 row and mark gross/computed/percent as requester-informational (F9 stays the only enforcement point).
Backward compatible? (a) yes if `lines` is optional at first; (b) yes (error removed, nothing emitted it).
Tenant/security impact: none new; (a) adds one CatalogPort call per request, no PHI.
IRD/regulatory impact: none (no invoice/tax change).
Alternatives considered: trust a client-sent gross (rejected: approver would see a forgeable number).
Tests that will prove it: (a) F15 with discount above absolute max -> 422; DTO gross/computed match the F8 quote. (b) none.

---

Title: CR-C4-FD-T07-002: draft_hash normalisation for new-patient discount approvals is unspecified
From chunk: C4            To owner: C4 (doc owner: founder) — 03-APP-FLOW F9 step 4, 05-SCHEMA discount_approvals.draft_hash
Type: api
Blocking? no for FD-T07 (fail closed); yes for US-FD-07.2 with a new patient (approval can never be consumed)
Problem: 03-APP-FLOW:88 binds consumption to "`draft_hash` of the normalised new-patient draft" and 05-SCHEMA:354 says "sha256 hex of normalised new-patient draft", but no document defines the normalisation (which fields, order, case/whitespace/phone/date rules, encoding). Client (F15) and server (F9) cannot compute the same hash, so discount.service.ts `checkConsume` refuses every approval without `patient_id` (403 `frontdesk.discount_approval_required`).
Proposed change (exact): define `draft_hash = sha256_hex(canonical JSON (RFC 8785) of {given_name, family_name, sex, dob|age, phone_e164})` after trim + NFC + lower-case names (exact field list for the owner to fix), published as a shared helper used by web and F9.
Backward compatible? yes (only enables a path that is refused today).
Tenant/security impact: the hash is of PHI fields; low entropy, so it must never be logged or exposed beyond the tenant (already tenant-scoped under RLS). No new public surface.
IRD/regulatory impact: none.
Alternatives considered: require an existing patient before requesting approval (simpler, changes US-FD-07.2 flow); bind on centre + base_fingerprint only (weaker binding, rejected).
Tests that will prove it: F15 with draft_hash from the helper, then F9 with the same new-patient draft -> consumed; altered draft field -> 403.
