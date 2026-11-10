# API-T15 impl (writer, after ruling)
Files changed: none. The ruling says no implementation change is needed, and the task files are perf tests only (the T06/T09/T10 services already exist).
[CONV] n/a.
Runs of the revised tests (`vitest run src/modules/instruments/__tests__/perf`) on a shared dev machine:
- Run A: 6/10 pass, 771 s (machine heavily loaded). 4 FAIL, including AC-08.5 drain with 5,914/9,000 accepted. The rest were cut off by `tail`. On the drain test, `submitMessageBatch` hit its batch time budget (ingest.service.ts:286) and returned `retry` for the remaining messages, which is the designed behaviour.
- Run B: 10/10 PASS, 167 s.
Open: the wall-clock thresholds are flaky under host load, because the harness is single-process and in-memory. The gate should run the tests on an idle runner, or with a real-PG harness via a CR.
