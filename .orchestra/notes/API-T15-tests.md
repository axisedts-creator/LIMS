# API-T15 tests (tester)
Files (services/api/src/modules/instruments/__tests__/perf/): `ingest.perf.test.ts` (E04: 100-msg batch p95<=3 s/max<8 s, steady 1–5 msg p95<=300 ms at 1x/10x, AC-08.5 drain of 9,000 msgs in 90 batches <=4.5 min + quota arithmetic), `device.perf.test.ts` (E05 p95<=500 ms AC-10.5; E03 p95<=100 ms; 1x and 10x), `messages.perf.test.ts` (E33 31-day window, page 50, 20 pages, p95<=400 ms at 1x 93k / 10x 930k msgs), `perf.helpers.ts`.
Run: `.orchestra\notes\API-T15-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/instruments/__tests__/perf`). ~4 min.
Result now: 10/10 PASS (T06/T09/T10 services already exist) — these are NOT red-first; there is no missing code to fail on.
Not covered: real-DB statement latency (in-memory worlds measure service overhead only); message list p95<=400 ms on a real DB index (service overhead only is covered); `evaluate_agent_health` 2 s/1,000 agents (worker, API-T14); event commit→C5 (C5/C0); agent-side drain/rate limit (Go agent). A real-PG load run needs a DB harness (db/tests) — raise a CR if wanted.
Wall-clock thresholds can flake on a loaded machine.
