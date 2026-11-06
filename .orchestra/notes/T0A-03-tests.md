# T0A-03 tests
- File: tools/lint/tests/rules.test.mjs (node:test, no deps; inline bad/good fixtures per rule). Run: `node --test tools/lint/tests/rules.test.mjs`.
- Contract (test-side choice): `tools/lint/rules/<rule>.ts` exports `name` and `check(path, source) -> [{rule, line(1-based), message}]`; [] = clean. Loaded by node type stripping.
- 9 rules: no-cross-module-import, no-foreign-schema-sql, no-supabase-in-browser, no-bare-set, no-raw-bs-lib, no-math-random, no-new-date-in-domain, no-dangerously-set-inner-html, no-console. 118 tests.
- Key ACs: AC-0A-3.4 (no-raw-bs-lib, incl. Dart + bsdate-dir allowance); AB-21 (identity/** naming core.dead_letters fails; identity/repository may name core.membership_branches; core/** may name dead_letters).
- Expected now: 118 of 118 fail ("tools/lint/rules/<rule>.ts must exist"). Verified by run.
- Assumptions (spec silent): no-bare-set also flags `set_config(…, false)`, not `UPDATE … SET`; no-supabase-in-browser scope = apps/web/**; no-foreign-schema-sql tested for `core.` only (no cross-module-schema cases); comments/strings must not trigger code rules.
- Not tested: CI wiring/CLI runner (T0A-10), the C2 fixture JSON (C2-owned), ESLint/Prettier configs.
