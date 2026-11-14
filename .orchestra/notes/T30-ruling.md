TESTS_WRONG — tests/docs/C2-T30.manual.test.mjs:127 and :129 compare raw routes.yaml values against `norm(r)`, which strips every `_` (line 20), so routes/permissions containing `_` can never match.

Reasons:
- Spec requires one manual page + in-app help per C2 screen (spec/chunks/C2-identity-admin/01-PRD.md:73 S24; 06-IMPLEMENTATION-PLAN.md:49 T30 "page per screen", "doc lint"). Naming the route/permission as written in routes.yaml is the test's own contract (test line 9), and verbatim names are mandated by CLAUDE.md.
- contracts/routes.yaml:52 `/admin/users/{membership_id}`, :55 `/platform/dead-letters/{dead_letter_id}` + `platform.dead_letter.manage`, :74 `platform.dead_letter.manage` all contain `_`; `norm()` turns page text into `{membershipid}` / `deadletter`, so a page naming them verbatim fails. Test is unsatisfiable, not a spec requirement.

Change in test (TESTER only):
- line 127: `assert.ok(t.includes(norm(path)), ...)`
- line 129: `if (perm) assert.ok(t.includes(norm(perm)), ...)`
(equal alternative: check `r.includes(path)` / `r.includes(perm)` on raw text). Keep messages, keep everything else unchanged.

Implementation: writer then writes pages naming route and permission verbatim from routes.yaml (backticks allowed).
