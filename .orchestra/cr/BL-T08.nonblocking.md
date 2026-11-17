Title: CR-C4-BL08-001: B16 DueRow.registration_no / patient_display have no source in billing
From chunk: C4            To owner: C0 / C4 spec (03-INTERFACE-CATALOG or FrontdeskPort read)
Type: api
Blocking? no (B16 is implemented with an interim source; real values need a ruling)
Problem: DueRow requires `registration_no` and `patient_display`; billing tables hold neither (registration/patient live in frontdesk, which 06-PLAN says billing does not read). BL-T08 uses [CONV] the order's first invoice `invoice_no` and `buyer_name` (balances.repo.ts listDues), which is not a registration number. Serves US-BL-11.1 (dues list).
Proposed change (exact): either a FrontdeskPort batch read `getOrderDisplays(orderIds) -> {orderId, registrationNo, patientDisplay}[]` that listDues calls, or a denormalised snapshot written at issue time. C0 picks.
Backward compatible? yes.
Tenant/security impact: patient name is PHI: the read must stay behind billing.invoice.read and be tenant-scoped.
IRD/regulatory impact: none.
Alternatives considered: invoice buyer name (used now; wrong for credit/other buyers).
Tests that will prove it: ledger.reads.handlers.test.ts B16 with the port faked.

---

Title: CR-C4-BL08-002: B8 RecordPaymentResult.receipt_no is required but not every payment has a receipt number
From chunk: C4            To owner: C0 (contracts/openapi/billing.yaml)
Type: api
Blocking? no
Problem: `receipt_no` is required in RecordPaymentResult, but `receipt_no_enabled = false` (billing settings) allocates none (the handler then omits the key and the stage-12 response check would reject it). Registration-transaction payments (`issueReceiptNo:false`) go through the port, not B8, so only the settings case applies.
Proposed change (exact): drop `receipt_no` from RecordPaymentResult.required.
Backward compatible? yes (consumers already must tolerate a missing receipt when disabled).
Tenant/security impact: none. IRD/regulatory impact: none.
Alternatives considered: refuse payments when receipt numbering is disabled (wrong: breaks the setting).
Tests that will prove it: contract test of B8 with receipt_no_enabled=false.

---

Title: CR-C4-BL08-003: B18 DailyCash has no place for gateway rows (collected_by NULL)
From chunk: C4            To owner: C0 (contracts/openapi/billing.yaml DailyCash)
Type: api
Blocking? no (gateway rows excluded [CONV] until ruling)
Problem: gateway ledger rows have `collected_by_membership_id IS NULL` (08 R8); `billing.v_pub_payment_collection` groups them under a NULL collector, but DailyCash `rows[].collected_by` is a required Actor. B18 therefore leaves them out, so B18 totals will differ from the view once C15 posts gateway money (PRD US-BL-11.1 requires equality).
Proposed change (exact): either make `rows[].collected_by` nullable for gateway rows, or add a separate `gateway` totals row to DailyCash. C0 picks.
Backward compatible? yes (additive / relaxing).
Tenant/security impact: none. IRD/regulatory impact: none.
Alternatives considered: synthetic "gateway" Actor (invents an identity; rejected).
Tests that will prove it: ledger.reads.handlers.test.ts B18 with a gateway row; equality with v_pub_payment_collection.

---

Also noted: a missing `TenantSettings.numbering.receiptNoPattern` maps to `billing.numbering_pattern_invalid` (registry defines it for the invoice `{branch}` case); kept as fail-closed, needs a registry line or a dedicated code.

Also noted (no CR yet): (a) refund rows are now in B18 (review item 1); gateway rows see CR-C4-BL08-003; (b) `display_name` of other users is the fixed label "Staff user" (IdentityPort.getActor is caller-only); (c) B8 maps `Idempotency-Key` to ledger.idempotency_key as `<order_id>:pay:<key>` ([CONV]); (d) an uninvoiced home_collection payment has no branch source in billing and answers common.not_found.
