# C17 plan tasks skipped (not in task JSON)

- HC-T23 — blocked: hard precondition P-7 (CR-C17-010 biometric/device-credential plugin pinned) not landed; no fallback gate (08 A19 D-127). Add back when P-7 lands.

Notes:
- Dependencies on P-n preconditions (C0 deliverables) are not task ids; tasks run against Prism + fakes until they land.
- `acs` use PRD ids (US-nn-k); where the plan cites REQ-SEC or DoD sections, those ids are kept.
- HC-T30 depends on all tasks except HC-T23.
