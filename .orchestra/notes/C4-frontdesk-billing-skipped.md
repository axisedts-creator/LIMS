# C4 plan tasks skipped (not in task JSON)

- BL-T21 — Pay by QR (B12/B13), Phase 1.5; blocked on C15 merge + flag `billing.settings.pay_by_qr_enabled` (milestone M6).
- FD-T18 — registration perf (p95 at 1×/10× seeds); needs load script/staging, deferred to M5.
- BL-T24 — perf for eligibility/payment/registers; needs load/staging, deferred to M5.
- J-T02 — nightly E2E journeys; needs compose stack + other chunks' fakes→real (05-DoD §5.2).

Note: wildcard "Maps to" story ids (e.g. US-FD-01) expanded to AC ids `US-FD-01.n` using counts in 01-PRD.md §8; ranges like `US-FD-11.2–3` expanded. Where the plan cites no story (FD-T01, BL-T01, BL-T23…), `acs` is `[]`; spec refs (07-SECURITY §6, 04-UI-UX §8) kept as text. Task files are directories/globs where the plan gave `handlers/*` etc.
