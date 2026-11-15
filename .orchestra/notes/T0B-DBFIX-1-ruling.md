TESTS_WRONG — `tests/db/T0B-DBFIX-1.fixtures.test.mjs` "every INSERT INTO identity.platform_staff fixture has a literal role_code from the CHECK list" flags non-fixture text; the role codes involved are all in the CHECK list.
Reasons:
1. The task brief (inbox T0B-DBFIX-1-arbiter.md:22, LD-230 (1) at :30) only requires that "every platform_staff fixture role_code is in the CHECK list". It says nothing about how dynamic SQL is shaped or what an assertion description says.
2. db/tests/identity/PLATFORM-DDL-1_policies.test.sql:130-133: the role_code is the literal 'platform_support', which is allowed. At test.mjs:75 the lazy `VALUES\s*([\s\S]*?);` capture runs past the closing `$$` into the format() arguments `pg_temp.uid(2)`, etc., so tuples() reads them as rows. That gives 8 false findings.
3. db/tests/core/T0B-03_audit.test.sql:177-183: this INSERT goes into a stand-in identity.platform_staff (id, user_id, is_active). The file creates that table itself, only when `to_regclass('identity.platform_staff') IS NULL`. The stand-in has no role_code column, so it is not an LD-230 (1) fixture.
4. db/tests/identity/T0B-06_definers.test.sql:467: the description text "cannot INSERT into identity.platform_staff directly" matches the case-insensitive count at test.mjs:88. That false finding is only in the count of INSERTs not in VALUES form.
Change the test (keep the assertion and the inserts>=9 / rows>=15 floor):
a. End the VALUES capture at the first `$$` or `;`, whichever comes first, e.g. `VALUES\s*([\s\S]*?)(?=\$\$|;)`.
b. Skip INSERTs whose column list lacks role_code only in a file that CREATEs identity.platform_staff without a role_code column. Flag every other such INSERT as now.
c. Strip single-quoted string contents before the `all` count at test.mjs:88, or count only `INSERT INTO identity.platform_staff (`, so description strings are not counted.
Note: at HEAD a5b461b0 the 'platform_admin' literals still exist (definers/T0B-08_*, identity/AUTH-*, SESSION-ACTOR-1, T0B-06:80-81). The writer must still commit the fault (1) repair. This ruling does not excuse it.
