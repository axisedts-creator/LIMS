TESTS_WRONG — the test asserts something the spec does not require
Reasons:
- spec/chunks/C3-catalog-pricing/02-TRD.md:503 fixes `analyteRef = upper { upper | digit | "_" }`: a ref must start with an upper-case letter. `__PROTO__` starts with `_`, so it is not a legal analyteRef; the parser must report errors, not `[]`.
- spec/chunks/C3-catalog-pricing/01-PRD.md:104 confirms analyte codes match `^[A-Z][A-Z0-9_]{0,31}$`; `__PROTO__` can never be a real analyte code.
- spec/chunks/C3-catalog-pricing/02-TRD.md:489 — one grammar shared by C3 and C5; the shared parser must not accept codes C3 forbids.
- Security intent (inert codes, `missing_input:<CODE>`, 02-TRD.md:513) is still covered by `CONSTRUCTOR` / `TOSTRING` and the `{"__proto__":"5"}` input half.
Change to packages/shared-ts/test/formula.test.mjs:286-289: replace `'__PROTO__'` in the loop with grammar-legal `'PROTO__'` (keep the `errors === []` and `missing_input:PROTO__` asserts), and add
`assert.ok(parseFormula('__PROTO__ + 1').errors.length > 0)` (a ref starting with `_` is a syntax error).
Do not change the implementation.
