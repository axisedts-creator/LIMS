TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/chunks/C0-foundation-contracts/02-TRD.md:241 requires the first statement of every transactional migration file to be `SET LOCAL ROLE lims_owner;`, enforced by `check-migrations.ts` (db/tools/check-migrations.ts:35-36). spec/chunks/C0-foundation-contracts/05-SCHEMA.md:494 and 03-APP-FLOW.md:71 restate it.
- The test `services/api/src/modules/identity/__tests__/platform-ddl-1.static.test.ts:56` demands that EVERY statement of 20261115191000_identity__add_platform_policies.sql be `CREATE POLICY`, which makes the file unable to satisfy 02-TRD:241. LD-223 asks for "additive only" and "no change to an existing policy, grant, function, trigger or table"; a role switch changes nothing and is not forbidden by LD-223.
- Change (line 56 only): exclude exactly one leading role switch, e.g.
  `const s = stmts(sql); expect(s[0]).toMatch(/^set\s+local\s+role\s+lims_owner$/i); expect(s.slice(1).every((x) => /^create policy/i.test(x))).toBe(true);`
  This keeps the intent (nothing but CREATE POLICY after the mandatory switch) and pins the switch to the first position.
- Lines 54-55 (DROP / ALTER / GRANT / DEFINER / CREATE ROLE regexes) stay unchanged; `SET LOCAL ROLE` matches none of them. Line 79 (F2 owner check) is not disputed and stays.
- No spec conflict, so no CR.
