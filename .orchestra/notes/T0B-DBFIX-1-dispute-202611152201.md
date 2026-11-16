# T0B-DBFIX-1 dispute (writer)

Disputed test: `tests/db/T0B-DBFIX-1.fixtures.test.mjs` > "LD-230 (1) ... every INSERT INTO identity.platform_staff fixture has a literal role_code from the CHECK list".
After the fault (1) repair, 44/45 pass; this one fails on 10 findings that are all parser false positives, not bad role codes:

1. `db/tests/identity/PLATFORM-DDL-1_policies.test.sql:130,132` (8 findings "role_code is not a literal ()"): the rows are `format($$INSERT ... VALUES (%L, %L, ..., 'platform_support', %L, %L)$$, pg_temp.uid(2), ...)`. The lazy `VALUES\s*([\s\S]*?);` runs past the closing `$$` to the next `;`, so `tuples()` also parses the format arguments `pg_temp.uid(2)`, `(102)`, ... as rows (2 inserts x 4 bogus tuples). The real literal is `'platform_support'` (in the CHECK list).
2. `db/tests/core/T0B-03_audit.test.sql:183` ("insert without role_code column"): the insert targets a stand-in `identity.platform_staff (id, user_id, is_active)` the test itself CREATEs at line 178 only when the identity schema is absent; that stub has no role_code column, so the insert is correct.
3. `db/tests/identity/T0B-06_definers.test.sql` ("1 platform_staff insert(s) not in INSERT (cols) VALUES form"): the `/INSERT\s+INTO\s+identity\.platform_staff\b/gi` count is case-insensitive and matches the assertion description text "lims_api cannot INSERT into identity.platform_staff directly" (line 469). Both real inserts (lines 81, 468) are in VALUES form with allowed codes (`platform_support`, `platform_superadmin`).

None of these files is in the LD-230 (1) fault list, and none holds a role_code outside the CHECK. Changing their SQL (or an assertion description) only to satisfy the parser would be gaming the test.
Suggested test fix (tester): skip the dollar-quoted `format($$...$$, args)` tail (stop the VALUES capture at `$$`), skip platform_staff inserts in files that CREATE a stand-in platform_staff without role_code, and count only `INSERT INTO` that is not inside a quoted string.

State of the working tree (uncommitted, writer stopped per the inbox rule):
- done: (1) 6 files (role codes -> platform_superadmin; T0B-06 -> platform_support so the bootstrap tests 25/11 still see no active superadmin), (2) C12/C13 pg_temp.ins claims, (6) T0B-06 tenant_settings, (7) generator + all probes regenerated (`--check` ok; `_registry.sql` and identity.tenant_contract_acceptances were stale only in line endings), (8) run-suites.sh stub, (9) both expectations.
- not yet done: (3), (4), (5), (6) lock_reason / hmac_len / T0B-03_audit:149, the out-of-scope non-blocking CRs, impl notes.
