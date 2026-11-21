# T0D-UIGUARD-1-SMARTREPORT tests (tester)
- Only change: deleted the SMARTREPORT legacy entries (rule 5, rule 6, rule 7) from apps/web/src/core/__tests__/uiguard1.exceptions.ts (LD-441). No new test file: uiguard1.guard.test.ts is the proof.
- Now red for the right reason: rule 5 (WordingTerms, CheckTab, GroupsTab header row), rule 6 (SummaryReview chart without ChartCard), rule 7 (raw h2/h3/ul in ReviewPanel, TextsTab, PreviewDialog, SummaryReview).
- Writer: fix those screens, then delete the SMARTREPORT lines from notes/T0D-UIGUARD-1-exceptions.md. Never edit the registry (LD-441).
- Writer: rs-cN snapshots, if any change, are re-recorded by the writer (LD-440).
- Run: .orchestra\notes\T0D-UIGUARD-1-SMARTREPORT-verify.cmd (build:nav + vitest uiguard1 config, from apps/web).
- Not covered: smartreport feature tests (uilist1.smartreport, sr-t*) are not in verify.cmd; they must stay green and are run by the full suite.
