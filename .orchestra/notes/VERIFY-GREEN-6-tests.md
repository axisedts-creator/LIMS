# VERIFY-GREEN-6 tester (LD-423, LD-426: only the tester role may keep edits to existing test files)
- Applied (test files/helpers only, types + msw 3 key; no product file, no emitted value/rounding/status/SQL change):
  - msw `onUnhandledRequest` -> `onUnhandledFrame` in 37 files (catalog 21, frontdesk 8, billing 8).
  - catalog: web-t32.server `load` default `Record<string, any>`; web-t32.components `res as Record<string, unknown>`; web-t33/t34 `ord(): Record<string, unknown>`; web-t35 `| undefined` on Call.form, server `form`, multipart `Part.filename`; web-t35 fetchSpy `(..._a: unknown[])`; testmgmt1.setup `Mock<...>` types.
  - billing: nav-complete.billing `satisfies SpecRow[]`; uilist2.invoices `as unknown as`.
  - `as any` 11 -> 2 (URL stubs, printcfg1 json, frontdesk `as any[]` replaced by narrow types).
- Result: tsc 0 errors under features/{catalog,frontdesk,billing}; vg6 7/7, web-t32 107, web-t35 96, acct1 194, regscreen1 75, regscreen2 87, uilist2 4, testimport1 70 green.
- Not mine: core/nav nav-complete admin-pack/build tests fail 4 (pre-existing, outside the three dirs).
- Run: see VERIFY-GREEN-6-verify.cmd (vg6 + t32 + t35).
