# T0A-HEADERS-1 tests (tester)
- `services/api/src/core/__tests__/header-validation.test.ts`: route requiring If-Match, Idempotency-Key, X-Lims-App-Instance via the real `schemaController` + `installErrorHandlers`. Lower/mixed-case request and schema accepted; each missing header -> 400 common.validation_failed naming it; Idempotency-Key >64 / bad If-Match / bad optional header -> 400; body and query stay case-sensitive; schema not mutated.
- `services/api/src/core/__tests__/header-contract.test.ts`: loads every contracts/openapi/*.yaml (not `_*`), compiles each op's header schema through the core factory, validates lower-case headers with valid samples, and checks dropping any required header is refused. Prints the count line `[T0A-HEADERS-1] operations ...`.
- Run: `.orchestra/notes/T0A-HEADERS-1-verify.cmd` (adds the existing core openapi tests).
- State now (before the fix): 4 of 7 unit tests and 1 of 2 contract tests fail, all for the right reason (lower-case header refused as `field_required` on `/Idempotency-Key` etc.; 535 of 535 operations refused, 0 wrongly accepted).
- Contract counts on this lane (main, before C0-0B): 535 operations with a required header; If-Match 324; Idempotency-Key 280; X-Lims-* 46 (an operation may carry several).
- Writer: lower-case top-level `properties` keys and `required` entries in a COPY of the schema when `httpPart === 'headers'` in `buildValidator` (core/openapi.ts); leave body/query/params alone.
- After merge, record these counts and state that the second sweep (T0B-SWEEP-2) can be reset (done_when 5).
