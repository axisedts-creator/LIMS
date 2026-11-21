# T0D-UIGUARD-1-FRONTDESK tests (tester)
- Only test change: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted all FRONTDESK legacy blocks (rule 4 and rule 5 of LD-434; rule 7 of LD-436, 5 routes). The pinned registration-form entries (rules 3 and 5 on /frontdesk/registrations/new, rule 3 on /frontdesk/orders/[order_id]) stay as the brief says.
- Existing guard uiguard1.guard.test.ts now fails on the real violations: rule 4 (orders, patients), rule 5 (OrderView, PatientView), rule 7 (discount-approvals, orders, patients, registrations/new incl. billing ReceiptPrintView, settings). 3 tests red, 33 green. No new test file needed.
- Writer: fix screens until green, then delete the FRONTDESK lines from notes/T0D-UIGUARD-1-exceptions.md (writer-owned). Nobody re-adds entries (LD-439). rs-cN snapshots: writer re-records (LD-440).
- Run: .orchestra/notes/T0D-UIGUARD-1-FRONTDESK-verify.cmd (build:nav, then the uiguard1 vitest config, from apps/web).
