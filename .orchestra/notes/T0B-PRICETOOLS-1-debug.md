## debug 2026-11-18
- Verify log: 125/126 files green; the only failures (7) are catalog/__tests__/partyset/doctor.test.ts (commission_bp), a T0B-PARTYSET-1 test (commit bfdde7a63) that reached this lane by merge.
- Cause: PARTYSET impl for the doctor field commission_bp is not on this lane (referrers.service.ts has no commission_bp). Not a PRICETOOLS defect; ruling item 7 already sends it to the PARTYSET owner.
- Fix: none in PRICETOOLS code (adding commission_bp here is PARTYSET scope). Re-run verify once PARTYSET impl merges, or exclude partyset/ from this task's verify.
