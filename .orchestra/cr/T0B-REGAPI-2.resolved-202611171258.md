Title: CR-C0-REGAPI-2: coupon / visiting charge tax treatment, and RegistrationNumberPreview receipt field per LD-323
From chunk: C0-0B            To owner: C0-0C (contract) + founder (money, LD-310)
Type: api
Blocking? yes — T0B-REGAPI-2 (06-IMPLEMENTATION-PLAN row T0B-REGAPI-2): 3 registration.test.ts pins (coupon/visiting charge in totals and invoice) and the preview label/empty-field rule cannot be met.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  A) MONEY. done_when (1)(7) require coupon and visiting charge in server-computed totals. No spec line states (i) whether a coupon is a pre-tax bill discount (reduces VAT) or a post-tax deduction from net, (ii) whether a visiting charge is an invoice line and whether it is VAT-taxable or exempt. Coupons were out of v1 (spec/chunks/C16-patient-engagement/01-PRD.md:81; spec/program/08-CR-REGISTER.md:609 CR-C16-021 DEFER). Billing computes VAT from lines + discounts (BillingCommandPort.computeQuote / issueOrderInvoice), so a post-tax deduction never reaches the invoice; a pre-tax coupon changes VAT so the test pin NET-7260 (10 % of NET incl. VAT) is unreachable. LD-310 keeps money decisions with the founder.
  B) CONTRACT. contracts/openapi/frontdesk.yaml:7096-7120 RegistrationNumberPreview: next_receipt_no required, minLength 1, additionalProperties false, example RC-2083/84-000077 (line 3804). LD-323 (a)(b)(c) rules the value is the next INV number via previewInvoiceNo, labelled "assigned when saved", and empty with the label when the port call fails. An empty string is schema-invalid and there is no label property.
Proposed change (exact):
  A) Founder chooses one, recorded as an LD:
     A1 coupon = bill-level discount before VAT (passed to billing as a discount; VAT recomputed); visiting charge = invoice line, VAT-exempt service (or taxable: state which).
     A2 coupon = deduction after VAT on totals.net and on the invoice (needs a BillingCommandPortV1 change to carry a post-tax adjustment).
     Then the tester re-pins registration.test.ts:52-69 and the save "invoice is for the reduced total" test to the chosen formula.
  B) OpenAPI diff (frontdesk.yaml RegistrationNumberPreview):
     next_receipt_no: { type: [string, 'null'], maxLength: 64, description: 'Preview of the next invoice (bill) number (LD-323; issueReceiptNo=false, the invoice is the receipt). Assigned when saved; two users may see the same preview. null when the preview is unavailable.' }
     add next_receipt_no_label: { type: string, minLength: 1, maxLength: 64, description: 'Always "assigned when saved".' } to properties and required
     example line 3804: next_receipt_no: 2083/84-000077 (tenant invoiceNoPattern shape) plus next_receipt_no_label.
Backward compatible? B: no strictly (nullable + new required field); only consumer is T0D-REGSCREEN-2 (not merged), so no live client breaks. A: changes totals semantics of new fields only; existing orders without coupon/visiting charge unchanged.
Tenant/security impact: no RLS change, no PHI field, no new public surface. Preview reads billing.fiscal_counters via the port only (08 R25 kept).
IRD/regulatory impact (billing changes only): A affects VAT base and invoice lines (13 % VAT on taxable lines); founder/accountant must confirm the IRD treatment of discounts and service charges before choosing A1 or A2.
Alternatives considered: keep totals unchanged and only store coupon/visiting amounts on the order (current interim; misses done_when (7)); render the label as UI text only (misses the "field empty" rule without a schema-invalid response).
Tests that will prove it: re-pinned registration.test.ts quote/cap/invoice tests per A; schemaErrors('RegistrationNumberPreview', ...) clean for both the success and port-failure response; preview.test.ts LD-323 (e) tests.
