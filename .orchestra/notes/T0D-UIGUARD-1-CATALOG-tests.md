# T0D-UIGUARD-1-CATALOG tests (tester)
- Only test change: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted all 5 CATALOG legacy blocks (rule 1, 2, 3, 5 of LD-434 and rule 7 of LD-436). The `/catalog/icd` rule 2 line stays: it is PARTNERS.
- The existing guard (uiguard1.guard.test.ts) now fails on the real catalog violations: rules 1, 2, 3, 5 and 7 (5 tests red, 31 green). No new test file needed.
- Writer: fix the screens until green, then delete the CATALOG lines from notes/T0D-UIGUARD-1-exceptions.md (writer-owned). Nobody re-adds entries (LD-439). rs-cN snapshots: writer re-records (LD-440).
- Run: .orchestra/notes/T0D-UIGUARD-1-CATALOG-verify.cmd (build:nav, then the uiguard1 vitest config, from apps/web).
