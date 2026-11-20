## debugger 2026-11-20
- Cause: verify failures (5 tests, 3 files) are outside price tools: emptytbl2 expects a dev note that T0D-UIDASH-1 removed and uidash1/quality-t21 forbid. Test conflict, not impl bug.
- Fix: none in code (tests may not be edited; no smallest impl change satisfies both). Dispute written: T0D-PRICETOOLS-1-dispute.md.
- pricetools1 193/193 and rs-c2 74/74 per impl note; I did not re-run them.

## debugger 2026-11-20 (round 2, verify log 10:26:47)
- Cause: 4 failures in emptytbl2 config (emptytbl1.source x2, emptytbl2.anatomic BatchesScreen, emptytbl2.other WorksheetList). Old EMPTYTBL tests contradict LD-353 rules 5/6 changes made by UILIST-1/UISCAN-1/OFFLINE-3 in lab screens; no price tool file involved.
- Fix: none in code (tests locked; lab files not owned). Dispute written: T0D-PRICETOOLS-1-dispute.md. Stopped.
