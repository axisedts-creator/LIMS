APPROVE

LD-366 integration re-run review of `git diff 2dad62768..HEAD` (one commit, ce5c61466) plus the merge result 2dad62768.

- Feature diff: only the include order in db/tests/isolation/lab.result_signoff.test.sql and lab.verification_policy.test.sql changed (engagement.sql now after identity.sql). This is the gen-isolation-probes output and matches every sibling probe (for example analytics.*.test.sql:179-180). No SQL logic, RLS, grant or migration changed. The debug note is an allowed notes file.
- Merge union (registry-equality.test.ts against the main parent 2dad62768^2): every main line is still there. The only lines removed are the two expect lines and one comment, and each was replaced by a superset that adds LD316_VERLEVEL_ERRORS or LD316_VERLEVEL_CODES. SYNC, MSGDESK, TESTIMPORT, CONTENT and LD313/LD321 lists are all present. No SYNC2 list exists on main yet, so none was lost.
- No edits to spec/, tokens.json or db/migrations in the diff. The probe-rows fixtures are left uncommitted (LD-348).
- Verify (.orchestra/out/T0C-VERLEVEL-1-verify.log, 08:39): codegen 577/577, contracts 7 passed, API 6 files 301/301, boot 3 passed. The pgTAP step for T0C-VERLEVEL-1_verification_levels ran 106 s and the log shows no `not ok`/FAIL line. The log has no explicit pass summary, so the pass status comes from the harness exit code.
