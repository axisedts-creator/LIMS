# C13 plan tasks skipped (not in task JSON)

- T02 — schema review with C0 (feedback in CR thread; DDL/RLS owned by C0-0B, C13 never commits migrations). Blocked on C0-0B.
- T24 — swap fakes for real ports; gated on owners' chunk gates (C2, C3, C4, C6; CR-C13-003/005/007, CR-C4-006); staging E2E needs C1. Deferred to M5.

Notes:
- Plan §5 CR candidates (notification templates, webhooks, label views, TRF upload, native app, CR-C13-015) are not raised, so not planned.
- ACs are PRD criterion ids `US-nn.k`; plan ranges and whole-story refs expanded using criterion counts in 01-PRD.md §5. T01, T21, T23, T25 map to no US (acs empty).
- T02/T24 dropped from `depends`: T03/T06/T07 depend on T01 only (C0 schema assumed merged or on local branch).
