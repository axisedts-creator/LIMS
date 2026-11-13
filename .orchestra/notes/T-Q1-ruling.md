TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- Spec requires only that unknown internal failures map to `500 common.internal` with `request_id` only (spec/program/02-CONVENTIONS.md:416) and that `detail` carries no SQL/PHI/stack (02-CONVENTIONS.md:414). The test's remaining assertions (line 407) cover this and pass.
- Line 406 (`db.calls.some(verb === 'insert')`) is unsatisfiable by any implementation: `fakeDb` records calls only inside the original `tx.query` (test file line 79), but the wrapper at line 404 throws on INSERT before delegating to `q`, so the INSERT is never pushed. This is a harness defect, not a spec requirement.
- Plan row T-Q1 (spec/chunks/C16-patient-engagement/06-IMPLEMENTATION-PLAN.md:37) asks for centre-scoped CRUD with If-Match; nothing in it constrains how the fake records calls.

Change to make (tester): in the wrapper at line 404, record the call before throwing, e.g.
`if (verb({ text, values: values ?? [] }) === 'insert') { db.calls.push({ text, values: values ?? [] }); throw Object.assign(...); }`
(or set a local `reachedInsert = true` flag in the wrapper and assert it at line 406). Keep the line-407 assertions unchanged; ideally also assert `r.error.code === 'common.internal'` per 02-CONVENTIONS.md:416.
