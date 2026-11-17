CR_NEEDED — the binding brief/LD-326 demands a construct the binding X10 rule and its CI gate forbid, and forbids the only file change that could reconcile them.
1. LD-326 (inbox line 30) and the brief done_when (1) require `next_receipt_no` "type string or null"; the tests (regparity3-openapi.test.ts:53-56, 176-179) pin that faithfully, so not TESTS_WRONG.
2. spec/program/02-CONVENTIONS.md:466-474 (X10, binding): files are OpenAPI 3.0.3 using only the 3.0∩3.1 subset; Don't column lists `type: [x, "null"]` and `nullable: true`; Do = "Omit optional fields instead of null".
3. tools/codegen/lint-openapi.ts:181-182 (rule 1, OAS 3.0 meta-schema) and :194 (rule 2, type arrays) both reject it; the brief also requires "the existing contract lint ... pass" (done_when TESTS) and caps files at 6 with "no ... change" outside frontdesk.yaml + generated types/tests, so the lint cannot be widened: not IMPLEMENTATION_WRONG either.
4. LD-119 precedent exempted one rule-3 check only; a rule-1 meta-schema bypass is an X10 exception that only the lead (04-CHANGE-REQUESTS §3 / X10 "by CR") can grant.
5. LD-323 wording ("the field is empty with a label") is satisfiable X10-clean, so the lead must choose: keep null + authorize a lint exception, or re-rule to "" / omission.
6. Stale access-actions.ts and 003_audit__g_cs_access_actions.sql (LD-326 spec merge) exceed the 6-file cap; also needs a lead ruling.
CR text: .orchestra/cr/T0C-REGPARITY-3.md.
