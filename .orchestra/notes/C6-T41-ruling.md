TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
Reasons:
- spec/program/02-CONVENTIONS.md:410 — the Problem envelope carries field errors in `errors[]` (`{path, code, message}`), not `details`/`fields`.
- spec/program/02-CONVENTIONS.md:415 — "`errors[]` only for validation (`common.validation_failed`), JSON-Pointer paths."
- spec/program/02-CONVENTIONS.md:427 — business-rule failures with no code of their own -> 400 `common.validation_failed` with a JSON-pointer path in `errors[]`.
- The spec names no `details` or `fields` property, so the test reads property names that do not exist. `LimsError.errors` (services/api/src/core/errors.ts:31) matches the spec.
Change to regenerate.test.ts:119: replace `JSON.stringify(e?.details ?? e?.fields ?? [])).toContain('reason_text')`
with `JSON.stringify(e?.errors ?? [])).toContain('/reason_text')` (this checks the JSON-Pointer path the spec requires).
Keep the code check (`common.validation_failed`) and `untouched(s)` as they are.
