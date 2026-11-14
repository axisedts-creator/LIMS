TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. The disputed rule "every name is read by a tracked non-test source file" (infra/tests/static/test_t0d_dep01_images.py:29) sits under the header "tester's reading where the brief is silent" (line 9). No spec line asks for the full name to appear as a literal string. `.env.example` appears in spec only for REQ-SEC-037 placeholder-secret checks (C1 01-PRD.md:46,145; 07-SECURITY.md:16).
2. The spec names these variables in full and says the modules read them: LIMS_PAYMENTS_KEK_FILE in C1 02-TRD.md:534,644,678 and C15 02-TRD.md:393. The engagement module is the `LIMS_ENGAGEMENT_*` family of 02-TRD §10.1 (engagement/config.ts:1).
3. The code does read them, through a prefix it composes at runtime: payments/config.ts:49 `K = s => \`LIMS_PAYMENTS_${s}\`` (:83 'KEK_FILE', plus 'PUBLIC_BASE_URL' and 'ESEWA_FORM_URL'), and engagement/config.ts:21 `P = 'LIMS_ENGAGEMENT_'` with rawKey at :42 and :73-75. A whole-word literal grep cannot see these reads, so the test gives a false negative.
4. LD-188 rule 3 binds these names into render.yaml and .env.example, keeps T0D-DEP-01 green, and forbids edits to other module files. LD-192 rule 3 forbids product-code changes. That leaves the test as the thing to fix; option (a) of the dispute is not allowed.

Change to the test (tester): in tracked_source_names (lines 420-427), count a name as read when either
(a) its full name matches whole-word, as today, or
(b) some tracked non-test source file holds the prefix literal (`LIMS_<MODULE>_`, e.g. inside `` `LIMS_PAYMENTS_${ `` or `'LIMS_ENGAGEMENT_'`) AND the same file holds the remaining suffix as a quoted string literal (e.g. 'KEK_FILE').
Keep the other check_env_example rules as they are. Add one planted-failure case: a name whose prefix is present but whose suffix appears in no source must still be reported as unread.
