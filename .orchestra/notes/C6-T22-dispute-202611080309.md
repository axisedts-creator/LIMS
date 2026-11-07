# C6-T22 dispute (writer)
Tests `R14 no body` and `R16 no body` (`verify.revoke.test.ts` it.each rows `['no body', undefined]`, lines ~106/217) cannot pass against any impl.
Why: `revoke14(w, id, body: any = {reason_code:'issued_in_error'}, ...)` / `revoke16(..., body = {reason_code:'wrong_recipient'})` use a default parameter, so passing `undefined` sends the VALID default body. The handler is correctly called with a valid body and answers 200, so `codeOf(...)` throws "expected rejection, got success".
The other 10 R14 / 5 R16 validation rows (missing reason_code `{}`, array, string, ...) pass, so an absent body is already covered by `{}` (handler turns it into the same `common.validation_failed`).
Fix (tester): pass `null` instead of `undefined`, or call `w.run(R14, ctx, { params, body: undefined })` directly (run() defaults to `{}`).
Result today: 104 pass, 2 fail (these two only).
