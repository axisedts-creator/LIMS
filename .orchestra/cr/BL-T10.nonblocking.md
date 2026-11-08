Title: CR-C4-BL10a: error code for cancelling an invoice that is already fully credited
From chunk: C4            To owner: C0-0C
Type: api
Blocking? no (BL-T10 ships with declared `common.validation_failed` /invoice_id meanwhile)
Problem (what you cannot do today, with the user story / acceptance criterion it serves): US-BL-04.1 — cancel = status cancelled + a credit note for the not-yet-credited remainder. If partial credit notes (US-BL-05.1) already credited every line, the remainder is 0 and `credit_notes__totals__ck` forbids a zero-value note, so cancel must be refused. contracts/openapi/billing.yaml cancelInvoice x-error-codes (L542-552) has no code for this; 02-CONVENTIONS:483 forbids returning an undeclared code.
Proposed change (exact): add `billing.invoice_immutable` (409, already in errors.yaml) to cancelInvoice x-error-codes. Same for issuePartialCreditNote if wanted (line already fully credited currently -> 400 validation). Alternative: a new code `billing.invoice_fully_credited` (409).
Backward compatible? yes — additive error code.
Tenant/security impact: none; no RLS, no PHI, no new surface.
IRD/regulatory impact (billing changes only): none; no note is issued, no number consumed (dry-run + allocate-last unchanged).
Alternatives considered: `common.validation_failed` (used now; semantically weak — the request is well-formed); `common.version_conflict` (misleading, retry will never succeed).
Tests that will prove it: invoice.cancel.test.ts "nothing left to credit" case narrowed from generic LimsError to the ruled code (+409); nothing written, no event.
