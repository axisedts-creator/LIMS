APPROVE
Re-review of diff 9d0dc8b5..HEAD after review fixes (4dd046b4, f2d73e4c).
Item 1 fixed: `perf/messages.perf.test.ts` covers TRD §12.2 "Message list (31-day window) p95 <= 400 ms per page of 50" at 1x (93,000) and 10x (930,000). It runs a first page plus 19 cursor pages and asserts no errors, 50 items per page, no overlap between pages, and p95 <= 400. It uses the real `listInstrumentMessages` (E33) params `receivedAtFrom`/`receivedAtTo`/`limit`/`cursor`.
Item 2 fixed: `.orchestra/cr/API-T15.md` follows the 04 template. It asks C0 for a real-PG 1x/10x harness (DoD §3 item 5) and defers `evaluate_agent_health` to API-T14 and commit->C5 to C0/C5. Paths are owned. No PHI, secrets or invented names.
Verified run: `pnpm --dir services/api exec vitest run src/modules/instruments/__tests__/perf` gave 3 files, 12/12 pass, 160.6 s.
Non-blocking: API-T15-tests.md:5 still says "raise a CR if wanted". The tester should point it at `.orchestra/cr/API-T15.md`. The wall-clock thresholds can flake under host load (writer saw one drain-case failure). The CR covers the durable fix.
