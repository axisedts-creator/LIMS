TESTS_WRONG — tests/db/T0B-MFAPOL-1.static.test.mjs forbids the mandatory leading owner role switch; allow exactly one leading `SET LOCAL ROLE lims_owner;` then exactly the three ALTER POLICY statements.
Reasons:
- spec/program/02-CONVENTIONS.md:717: `lims_migrator` "runs migrations; `SET ROLE lims_owner` first statement of every migration session". A migration without it cannot ALTER POLICY on a lims_owner-owned table (02-CONVENTIONS.md:716, lims_owner is object owner).
- The repo gate implementing that rule (db/tools/check-migrations.ts:35-36) requires first statement `SET LOCAL ROLE lims_owner` for transactional files; all 40 existing migrations carry it. The test as written makes the task unsatisfiable together with the gate.
- The task brief/LD-252 "nothing else" / "no other statement kind" targets DROP/REVOKE/GRANT/table/column/function/trigger/other-policy changes; a session role switch is not a schema change and is required by the higher-precedence convention (CLAUDE.md precedence: 02-CONVENTIONS > chunk docs/task brief wording).
Change the test precisely:
1. migrationDefects(): if sts[0] matches /^SET LOCAL ROLE lims_owner$/i, shift it; else push 'first statement must be SET LOCAL ROLE lims_owner'. Then keep "exactly 3 statements" and the ALTER POLICY regex on the rest. A second SET/RESET ROLE anywhere stays a defect.
2. Prepend `SET LOCAL ROLE lims_owner;` to GOOD; add mutant 'missing SET LOCAL ROLE' (GOOD without that line) and mutant 'role switch not first' (moved after the first ALTER).
3. In the 'select USING only' and 'agree' tests, drop the leading SET LOCAL ROLE statement before mapping statements through the ALTER POLICY regex.
No other assertion is weakened; every other check stays as is.
