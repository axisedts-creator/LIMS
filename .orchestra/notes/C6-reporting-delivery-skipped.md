# C6 plan tasks skipped (not in task JSON)

- C6-T27 — WhatsApp transport: gated on B9 (client Meta verification), founder provider choice, and official provider docs (WHATSAPP.md). Milestone M6.
- C6-T28 — SMS transports Sparrow/Aakash: gated on official provider API docs. Milestone M6.

Notes:
- C6-T42 (portal dues payment) is included, built against PaymentProviderPort/BillingPort fakes; release only after C15 chunk gate (M7).
- Tasks with `pending-cr` (T17, T26: CR-C6-019) are included; affected tests are marked `pending-cr`, not skipped.
- Wildcard ACs expanded from 01-PRD.md ids (AC-11.* = 11.1–11.12, etc.). T31/T33/T34/T40 have empty `acs` (plan lists none specific). `E8` kept verbatim in T41. Non-C6-task deps (C0 cores/DDL, CRs, fakes) are in `done_when`, not `depends`.
- `verify` = `pnpm -s verify` for code tasks; empty for T35 (docs).
- Plan order kept as in the plan table (T38–T40 and T35 after T44).
