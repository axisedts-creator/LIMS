# T0B-MFAPOL-1 dispute (writer)
Test: tests/db/T0B-MFAPOL-1.static.test.mjs, `migrationDefects()` line 55 (`expected exactly 3 statements`) and line 58 (every statement must be `ALTER POLICY .. ON identity.mfa_factors`).
Why it is wrong: every migration must start with the owner role switch `SET LOCAL ROLE lims_owner;`.
- spec/program/02-CONVENTIONS.md:717: `lims_migrator` "runs migrations; `SET ROLE lims_owner` first statement of every migration session".
- db/tools/check-migrations.ts:35-36 rejects any migration whose first statement is not `SET LOCAL ROLE lims_owner` ("first statement must be the owner role switch"). All 40 existing files in db/migrations carry it.
- db/tests/run-suites.sh:27,37 applies migrations as `lims_migrator`, which does not own identity.mfa_factors; ALTER POLICY needs the table owner, so a 3-statement file without the switch fails at apply time (42501 must be owner) and also fails check-migrations.
So no migration can pass both this test and the repo's migration gate / runner.
Proposed fix (tester): allow exactly one leading `SET LOCAL ROLE lims_owner` statement, then exactly the three ALTER POLICY statements, e.g. in migrationDefects: `if (/^SET LOCAL ROLE lims_owner$/i.test(sts[0] ?? '')) sts.shift(); else bad.push('first statement must be SET LOCAL ROLE lims_owner');` (and the same shift in the 'select USING only' and 'agree' tests, which map every statement through the ALTER POLICY regex). Add a mutant "missing SET LOCAL ROLE". The `GOOD` self-test text gets the leading line too.
Nothing implemented; writer stopped per inbox rule. No files other than this note were changed.
