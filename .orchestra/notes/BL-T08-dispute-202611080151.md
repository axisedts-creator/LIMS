# BL-T08 dispute (writer): one test contradicts the others

Test: `service/__tests__/ledger.payment.test.ts` line 44–52, "2: later card 1,250.00 (reference) -> RC receipt ...". It expects `r.receiptNo` and `w.ledger()[1].receipt_no` to be `RC-083/84-000001` / `receipt_seq: 1` for the SECOND payment.

Why it is wrong: the first call in that test, `pay(w, svc, ctx, { amount: npr(100000) })`, uses the default `input()` (`issueReceiptNo: true`, method cash), exactly like the first call of "RC series per fiscal year" (line 152–160), which expects two such default payments to get `000001` and `000002` (passes). Same input shape, so the first cash payment of test 2 takes `000001` and the card payment correctly gets `000002`. No rule in TRD §6.3 / PRD US-FD-08.2 gives a receipt to the second payment but not the first (US-FD-08.1 itself: "cash 1,000.00 ... due 1,250.00" - a part payment gets a receipt too). Gapless numbering (also asserted at line 199) forbids skipping 000001.

Fix (tester): in test 2 expect `RC-083/84-000002` and `receipt_seq: 2` (lines 48 and 52), or make the first payment `issueReceiptNo: false`.

State: 147/148 BL-T08 tests pass, the rest of `src/modules/billing` passes (703 passed, 45 skipped live/DB tests, this 1 failed). Stopped on this test; no test file edited.
