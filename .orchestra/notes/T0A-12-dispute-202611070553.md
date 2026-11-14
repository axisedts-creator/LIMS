# T0A-12 dispute (writer)
Test: `packages/shared-ts/test/formula.test.mjs:284` "prototype-pollution-ish codes are inert" — asserts `parseFormula('__PROTO__ + 1').errors` is `[]`.
Why wrong: C3 02-TRD §7.1 grammar fixes `analyteRef = upper { upper | digit | "_" }` — a ref must START with an upper-case letter, so `__PROTO__` is not an analyteRef and must be a syntax error (impl returns `{offset:0, code:'syntax'}`). `CONSTRUCTOR` / `TOSTRING` already pass; the security intent (inert codes, `missing_input:<CODE>`) holds.
Proposed fix (tester): replace `'__PROTO__'` with a grammar-legal code (e.g. `'PROTO__'`), and/or add `assert.ok(parseFormula('__PROTO__ + 1').errors.length > 0)`. The JSON `{"__proto__":"5"}` input half of the test already passes.
Status: 101/102 of the T0A-12 suite pass; this is the only failure. Writer did not edit the test.
