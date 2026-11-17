# C6-T13 debug
- Cause: repository.static (C6-T03 test, "no inline SQL in service/handlers") failed on pre-existing C6-T04/T09 code: service/reports.service.ts (26 literals) and handlers/retry-render.handlers.ts (2). Not caused by T13 files.
- Fix: moved the SQL literals verbatim into repository/reports.repo.ts and repository/retry-render.repo.ts (const Q); callers use Q.<name>. Text and params unchanged.
- Result: api reporting 24 files / 850 tests pass; worker reporting suites pass. Pre-existing tsc error in contracts/ports/common.ts (TS2835) untouched.
