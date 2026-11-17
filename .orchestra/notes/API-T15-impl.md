# API-T15 impl (writer, after review)
Files changed: `.orchestra/cr/API-T15.md` (review item 2: CR for a real-PG 1×/10× load harness from C0, DoD §3 item 5; defers `evaluate_agent_health` to API-T14 and commit→C5 to C0/C5). No implementation code changed. Review item 1 (messages.perf.test.ts) was a test item, done by the tester.
[CONV] n/a.
Open: the review asks that API-T15-tests.md reference the CR. That file is a tester note and still says "raise a CR if wanted". The tester should point it to `.orchestra/cr/API-T15.md`.
Full perf run (`vitest run src/modules/instruments/__tests__/perf`): 11/12 pass, 192 s. The AC-08.5 drain case failed at 134 s. A rerun of that case alone passed (2/2). Same flakiness under host load as noted before (single-process in-memory harness, wall-clock thresholds). The CR covers the durable fix.
