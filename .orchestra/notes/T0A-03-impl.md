# T0A-03 impl
- Files: tools/lint/rules/{_scan,no-cross-module-import,no-foreign-schema-sql,no-supabase-in-browser,no-bare-set,no-raw-bs-lib,no-math-random,no-new-date-in-domain,no-dangerously-set-inner-html,no-console}.ts. No deps.
- [CONV] Shared `_scan.ts`: hand lexer blanks comments + marks string/template chars; code rules match only code chars, SQL rules match only string literals (whole file for `.sql`, `--` comments stripped).
- [CONV] no-foreign-schema-sql: `core.<t>` allowed in services/api/src/core/**; identity/repository/** allows any `core.<t>` except `dead_letters` (02-TRD l.743, CR-C2-002). Only the `core` schema is checked (no cross-module schema list in spec).
- [CONV] no-new-date-in-domain flags only zero-arg `new Date()` (parsing an ISO string needs no clock). no-supabase-in-browser scope = apps/web/**.
- Run: `node --test tools/lint/tests/rules.test.mjs` → 118/118 pass; check-paths + monorepo-skeleton tests still pass (153 total).
- Review round 1: [CONV] no-supabase-in-browser scope = apps/{web,portal,partner}/**; no-foreign-schema-sql treats `core.${…}` like dead_letters (flagged outside core/**, incl. identity/repository); no-raw-bs-lib exempts only `bikram-sambat` in *.test.*/*.spec.*/__tests__/ (test oracle). Run: rules 128/128, all tools/lint tests 163/163 pass.
- Open: lexer can't handle regex literals with quotes or JSX text with apostrophes (fix: TS compiler API). CLI runner/CI wiring + C2 fixture JSON = T0A-10/C2.
