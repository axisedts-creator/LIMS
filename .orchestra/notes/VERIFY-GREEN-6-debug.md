# VERIFY-GREEN-6 debugger
- Cause: writer's edits were not in the working tree (19 test files still used msw `onUnhandledRequest`; t32.server `load` generic, t33/t34 `ord()`, t35 exactOptionalPropertyTypes + fetchSpy tuple, t32.components json arg all untouched), so tsc gave 65 errors.
- Fix (test files/helper only, types + msw 3 key rename): onUnhandledRequest→onUnhandledFrame in 19 files; load default `Record<string, any>`; `res as Record<string, unknown>`; ord(): Record<string, unknown>; `| undefined` on optional filename/form; `vi.fn(async (..._a: unknown[])`.
- Result: tsc 0 errors under features/{catalog,frontdesk,billing}; vg6 7/7, t32 107, t35 96 green. No emitted value/rounding/status/SQL changed.
