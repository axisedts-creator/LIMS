## debug 2026-11-18
- Verify log: 125/126 files green; the only failures (7) are catalog/__tests__/partyset/doctor.test.ts (commission_bp), a T0B-PARTYSET-1 test (commit bfdde7a63) that reached this lane by merge.
- Cause: PARTYSET impl for the doctor field commission_bp is not on this lane (referrers.service.ts has no commission_bp). Not a PRICETOOLS defect; ruling item 7 already sends it to the PARTYSET owner.
- Fix: none in PRICETOOLS code (adding commission_bp here is PARTYSET scope). Re-run verify once PARTYSET impl merges, or exclude partyset/ from this task's verify.

## debug round 2 2026-11-18
- Same verify log: only partyset/doctor.test.ts (8, commission_bp) + real-modules-boot timeout (host load) red. main still has no commission_bp in services/api/src, so PARTYSET impl has not merged.
- Cause unchanged: cross-task dependency, not PRICETOOLS code. No implementation change made; lead must merge T0B-PARTYSET-1 impl first or exclude partyset/ from this verify.

## debug round 3 2026-11-18
- Same verify log, same 8 reds: partyset/doctor.test.ts (commission_bp) + real-modules-boot timeout (host load). No commission_bp in catalog services on this lane.
- Cause unchanged: PARTYSET-1 test merged without its impl; not PRICETOOLS code. No change made. Lead: merge T0B-PARTYSET-1 impl or exclude partyset/ from this verify.
