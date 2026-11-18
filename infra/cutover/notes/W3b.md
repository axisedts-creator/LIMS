# W3b (C7 instruments) typecheck fixes
- Scope: 4 test files under apps/web/src/features/instruments/__tests__ (rs-c7.behaviour, web-t03.components, web-t04.components, web-t06.components). No production code touched.
- 31 errors -> 0 (`pnpm typecheck`, grep for instruments paths).
- `{...props() as never}` spreads (TS2698) -> props helpers cast `as unknown as ComponentProps<Awaited<ReturnType<loader>>>`.
- web-t04: MSW `request.clone().json()` cast to `{ maps: any[] }`; conditional props spread cast `Partial<ComponentProps<typeof C>>` (exactOptionalPropertyTypes).
- web-t06: MSW request body cast to `Record<string, unknown>` before spreading. web-t03: one `!` on a `.find()` the test already asserts exists.
- Assertions, inputs and runtime behaviour unchanged; vitest pass counts before/after identical (8 configs).
