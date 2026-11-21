# T0D-UIGUARD-1-INSTRUMENTS tests (tester)
- Registry: deleted the INSTRUMENTS rule 5 and rule 7 entries from apps/web/src/core/__tests__/uiguard1.exceptions.ts (LD-441); the guard now goes red on the real violations (ReprocessDialog.tsx rule 5; InstrumentForm, InstrumentMappings, MessageDetail rule 7).
- New: apps/web/src/features/instruments/__tests__/uiguard1.instruments.test.tsx (OutcomeTable keeps header row when empty; every instruments component file passes rule 7 and rule 5; registry has no INSTRUMENTS line).
- Config: .../instruments/__tests__/vitest.uiguard1-instruments.config.ts (this file + core uiguard1.guard.test.ts).
- Run: .orchestra/notes/T0D-UIGUARD-1-INSTRUMENTS-verify.cmd
- WRITER: delete the INSTRUMENTS lines from notes/T0D-UIGUARD-1-exceptions.md (rule 5 line ~107, rule 7 section ~280-285); re-record rs-c7 snapshots yourself (LD-440; tester does not).
- Existing tests that pin old markup (rs-c7.screens snapshot, web-t05 / uilist1 / uiset1 text queries) may need writer-side snapshot update only; no other test edited.
