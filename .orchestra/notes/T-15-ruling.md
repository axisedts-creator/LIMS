TESTS_WRONG — the case `['r_s', []]` asserts a result the spec rule contradicts.
Change in `services/api/src/modules/catalog/__tests__/integration/referrers.service.test.ts:576`: replace `['r_s', []]` with `['r_s', ['AB3']]`. With an unescaped `_`, this query would also match AB4 ("underxscore"), so the case still catches over-matching. Nothing else in the test changes.
Reasons:
1. spec/chunks/C3-catalog-pricing/02-TRD.md:279 (#60): match = `doctor_code` prefix (upper-cased q) OR `name_normalised` **contains** normalised q, escaped LIKE (REQ-SEC-082).
2. AB3 display_name "Under_score Man" normalises to "under_score man", which literally contains "r_s" (unde**r_s**core). A literal contains-match must return AB3.
3. spec/chunks/C3-catalog-pricing/01-PRD.md:159 (AC-08.2): `%`/`_` matched literally — literal matching includes AB3, it does not exclude it.
4. spec/research/02-security.md:162 (REQ-SEC-082) requires escaping only; it never requires suppressing literal matches.
5. The same table's case `['er_s', ['AB3']]` (line 576) already relies on this literal substring, so `['r_s', []]` is internally inconsistent.
6. Implementation must not change: it returns `['AB3']`, which is what the spec requires.
