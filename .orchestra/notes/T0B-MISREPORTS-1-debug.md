# T0B-MISREPORTS-1 debugger (2026-11-18). No implementation change.
- Verify log: 11 failures, 5 files. Cause is not the implementation: (a) consultant contract still has net_billed_paisa (analytics.yaml:3996-3997), LD-346(1) edit is T0C-owned, not on this branch; impl is already volume only. (b) CSV BOM count, P13 x2 probe exceptions = test defects (dispute items 1-2). (c) party_billing paging needs >7 rows, fixture has 4 parties, contract is one row per party (dispute item 4).
- Dispute written/extended: .orchestra/notes/T0B-MISREPORTS-1-dispute.md. Stop: tester fix + T0C consultant edit needed. Live PG17 perf run still unexecuted.

# Debugger pass 2 (2026-11-18). No implementation change.
- Verify log: 5 failures. 4 in reports.live.test.ts (lines 172/176/186, 262, 300/303) pin `net_billed_paisa`; contract (analytics.yaml:3974/3976/4038/4127) and impl (domain/misReports.ts) already use `net_paisa` per LD-357. Test defect, dispute already in T0B-MISREPORTS-1-dispute.md (key rename only, values unchanged). Tester must fix.
- 5th: boot.test.ts "30 of 30" timed out at 30000ms in the full parallel run; not reproduced alone, no code cause found, looks like load. Re-run after tester fix; if it repeats, investigate.
