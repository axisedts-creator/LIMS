# C6-T41 dispute (1 test)
`regenerate.test.ts` > "`other` without reason_text -> common.validation_failed pointing at /reason_text" (line 119) reads `e.details ?? e.fields ?? []`.
`LimsError` (core/errors.ts:31) has neither: field errors live in `e.errors` (`[{path:'/reason_text', code:'common.field_invalid'}]`, same as R6/R7/R8 handlers), so the assertion sees `[]`.
The handler throws `invalid('/reason_text')` correctly; the code check on the same line passes. Fix the test: `JSON.stringify(e?.errors ?? [])`. I did not change the error class or the test.
