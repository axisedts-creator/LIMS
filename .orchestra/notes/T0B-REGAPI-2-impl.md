# T0B-REGAPI-2 impl, PASS 4 (writer; ruling 16:59 TESTS_WRONG applied by tester). STOPPED on one more fixture defect: see T0B-REGAPI-2-dispute.md.
- Files this pass: billing/service/invoice.service.ts previewNo: malformed pattern from formatDocumentNumber (common.validation_failed) mapped to billing.numbering_pattern_invalid, same as issue() at line 227.
- Earlier passes (unchanged): registration.service.ts (coupon pre tax bill discount, VISIT VAT exempt line, LD-327), parity.service.ts (next_receipt_no '' on failure + label, LD-331), BillingCommandPort.impl.ts + fakes nowOf, migration 20261117140000.
- [CONV] visiting line code VISIT / "Visiting charge" (spec names none).
- Checks: tsc clean; billing preview 8/9 (fail = fixture, dispute); frontdesk PG17 suite 1674/1676 (coupon concurrency + rollback now green; 2 fails = boot.test 60 s timeouts under host load); boot.test alone 30/30.
- Open: 3 green runs in a row not attempted while the dispute is open; migration 20261117140000 = FOUNDER push-cloud step; branch-scope invoice preview refused -> ''.
