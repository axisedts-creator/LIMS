# T0D-04 dispute (writer)
Test: `errors.test.ts:260-264` "non-registry http status on a thrown error (418) ... message not leaked" — `expect(res.body).not.toContain('teapot')`.
Why wrong: the only "teapot" in the body is `instance` = the request path `/v1/catalog/weird/teapot` (route param `kind`). The thrown message (`LEAKY`) contains no "teapot"; it is not leaked (body = 500 common.internal, registry-backed, validates Problem — line 262 passes).
It contradicts the suite's own rule that `instance` is the request path (lines 164-168, 237-240, 308 — incl. a 500 `common.internal` case at line 308), so no conforming impl can pass it.
Change: assert the message is not leaked instead, e.g. `expect(res.body).not.toContain('core.patients')` (already covered by expectProblem's LEAKY_FRAGMENTS), or `expect(JSON.parse(res.body).status).toBe(500)`; or drop line 263.
