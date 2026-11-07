# T0A-12 impl (writer)
- Files: packages/shared-ts/src/{decimal,formula,spreadsheet}/index.ts; tools/lint/rules/no-local-spreadsheet-guard.ts; packages/test-fixtures/spreadsheet/golden.json; packages/fakes/contract-tests/formula.vectors.json (C0-0C path — see .orchestra/cr/T0A-12.nonblocking.md).
- [CONV] decimal = bigint (stdlib), no third-party lib → nothing to pin/licence-check; every arithmetic result rounded to 28 sig digits half-away-from-zero (decimal.js-style); |exponent| > 1000 → `domain_error`.
- [CONV] input not a DecimalString (pattern, ≤ 40 chars) → `missing_input:<CODE>`; absent/non-integer ageDays/ageYears → `missing_input:@age_*`; round() n outside integer 0..6 → `domain_error`; and/or evaluate both sides (no masking of missing input).
- [CONV] type errors (boolean misuse, arity) reported as code `syntax`; too_deep counts parens/calls/unary/^ nesting AND AST depth; output > 40 chars sheds decimals half-up, integer part too large → `domain_error`.
- [CONV] AST is an opaque frozen handle (WeakMap) — forged ASTs throw TypeError.
- Ran (against tests revised per LD-40 ruling, commit 5a13130; impl unchanged): T0A-12 verify.cmd 102/102 pass; `tsc --noEmit -p packages/shared-ts` clean.
- Open: lint rule not wired into a CI runner (no runner exists for rules yet); Dart side not done.
