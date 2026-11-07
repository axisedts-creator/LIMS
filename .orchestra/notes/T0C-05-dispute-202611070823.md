# T0C-05 dispute — contracts/__tests__/ports.test.ts (T0C-02) contradicts binding LD-03

- LD-03 (2026-11-07): "LimsError must not use TS parameter properties (Node type stripping): declare fields explicitly and assign in the constructor." Review T0C-05 item 2 + new codegen test "LimsError loads under Node type stripping" require this; both now pass.
- Two T0C-02 tests still assert the old IC §4 form and fail (248/250 in contracts):
  1. `common.ts equals IC §4 block > code ... is verbatim the IC block` — compares common.ts code to the IC block, which has `constructor(readonly code: ErrorCode, readonly safeDetail?: string, readonly fieldErrors?: readonly FieldError[])`.
  2. `spot checks ... > LimsError has the 3-arg constructor` (ports.test.ts:129) — `toContain("constructor(readonly code: ErrorCode, readonly safeDetail?...")`.
- Both tests and LD-03 cannot hold at once. LD-03 overrides spec text, so the tests are wrong. Proposed test fix (tester): normalise the LimsError class in the IC-equality check to the LD-03 form, and change the spot check to assert explicit fields `readonly code: ErrorCode; readonly safeDetail?: string; readonly fieldErrors?: readonly FieldError[];` plus `constructor(code: ErrorCode, safeDetail?: string, fieldErrors?: readonly FieldError[])`.
- Impl kept per LD-03. Optional fields are assigned only when defined (exactOptionalPropertyTypes in tsconfig.base.json; tsc test passes).
