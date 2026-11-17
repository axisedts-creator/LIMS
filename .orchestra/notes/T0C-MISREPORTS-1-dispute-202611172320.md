# T0C-MISREPORTS-1 dispute (debugger, 2026-11-17)
- Failing case: tools/codegen/__tests__/misreports1-openapi.test.ts:62 (PINS.consultant.cols) still pins net_billed_paisa; verify log: "consultant lacks column net_billed_paisa" (only red case, 292/293).
- Spec: LD-346 RULING 2 / brief: consultant LOSES net_billed_paisa, default sort tests_count desc (A39-3); "the tester updates the contract test that pins the column".
- Implementation is already right: contracts/openapi/analytics.yaml:3985-3999 has no net_billed_paisa, sort tests_count desc.
- Fix (tester): drop net_billed_paisa from consultant cols at line 62 (optionally pin tests_count: integer). Not editing the test.
