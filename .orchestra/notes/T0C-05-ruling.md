TESTS_WRONG — contracts/__tests__/ports.test.ts asserted the IC §4 parameter-property form of LimsError, which binding LD-03 overrides.
- spec/program/03-INTERFACE-CATALOG.md:1146-1147 has `constructor(readonly code: ErrorCode, readonly safeDetail?: string, readonly fieldErrors?: readonly FieldError[])`.
- LD-03 (2026-11-07, task brief, binding for T0C-05, overrides spec text): "LimsError must not use TS parameter properties ... declare fields explicitly and assign in the constructor." Test and LD-03 cannot both hold; LD-03 wins.
- 08-CR-REGISTER.md has no addendum restoring the parameter-property form (grep LimsError: only lines 985, 2379, 2636, none about the constructor).
- Required test change (already in HEAD 2463706, ports.test.ts:109-151): in the IC-equality check, swap the IC LimsError class for the LD-03 form (explicit `readonly code/safeDetail?/fieldErrors?` fields + `constructor(code: ErrorCode, safeDetail?: string, fieldErrors?: readonly FieldError[])`), and assert the replacement matched. The spot check asserts that constructor and `not.toMatch(/constructor\(readonly/)`.
- Verified: `pnpm --dir contracts exec vitest run __tests__/ports.test.ts` gives 63/63 passed.
- Implementation stays as is: explicit fields, optional fields assigned only when defined (exactOptionalPropertyTypes).
