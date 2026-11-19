# SEC-ERR-1 tests (tester)
- New: services/api/src/core/__tests__/errors-5xx-detail.test.ts (unit toProblem over every 5xx/4xx code in contracts/errors.yaml + real bootstrap via the errors fixture, log captured with logStream).
- Fixture edits: __tests__/fixtures/errors/modules/catalog/index.ts (handler limsErrorInternalDetail) and root/contracts/openapi/catalog.yaml (GET /v1/catalog/internal/{code}).
- Run: `.orchestra/notes/SEC-ERR-1-verify.cmd` = `pnpm --dir services/api exec vitest run src/core/__tests__/errors-5xx-detail.test.ts src/core/__tests__/errors.test.ts`.
- Now: 17 tests fail (every 5xx code still returns detail; request_failed log line lacks it); all 4xx tests pass (unchanged behaviour).
- Contract: Problem.detail is optional in _common.yaml, so tests require the key OMITTED on 5xx (not a generic string). The real detail must appear in a log line containing `request_failed` (field name free).
- Not covered by design: the 501 pendingProblem stub (LD-325; detail is the public operationId, not an internal string). Implementer must leave it as is unless lead rules otherwise.
