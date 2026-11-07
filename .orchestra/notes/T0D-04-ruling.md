TESTS_WRONG — `errors.test.ts:263` asserts the body lacks "teapot", but the only "teapot" is the request path in `instance`, which the spec requires/permits.
Reasons:
1. spec/program/02-CONVENTIONS.md:399-412 — every non-2xx body is a Problem whose `instance` is the request path (example line 408); nothing removes `instance` on a 500.
2. 02-CONVENTIONS.md:414 forbids PHI/SQL/stack/file paths in `detail` (REQ-SEC-095); the thrown message (fixture `LEAKY`, catalog/index.ts:5) is the leak to guard against, not the path segment.
3. 02-CONVENTIONS.md:416 — unknown internal failures -> `500 common.internal`; a 418 is not a registry status, so it fails closed to that.
4. The suite itself asserts `instance` = path (lines 167, 240, 308), so line 263 cannot pass alongside them with any conforming implementation.
Change in the test (lines 260-264): keep `expectProblem(res, ...)` but tighten it to `{ status: 500, code: 'common.internal' }`; replace line 263 with
`expect(JSON.parse(res.body).instance).toBe('/v1/catalog/weird/teapot');` (optional) and rely on expectProblem's LEAKY_FRAGMENTS check (core.patients, SELECT, /srv/lims, db.js) for the "message not leaked" claim. Do not assert absence of "teapot".
