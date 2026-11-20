APPROVE

# VERIFY-GREEN-6 review (reviewer), diff e5891c90d..HEAD (cb58414d4 tester, df6f0b730 writer)

- Scope: 44 files, all under apps/web/src/features/{catalog,frontdesk,billing}/**/__tests__ plus the task's own .orchestra/notes files. No product file, no spec/ edit.
- Changes are type-only plus the msw 3.0.3 option rename `onUnhandledRequest` -> `onUnhandledFrame` (verified present in node_modules msw@3.0.3 lib/_chunks/shared-options.d.ts; the old key was ignored, so 'error' mode is now actually enforced and suites stay green).
- Escape hatches: no added @ts-ignore / @ts-expect-error / @ts-nocheck / skipLibCheck / .skip / .todo; no added `as any` (11 prior `as any` replaced with `as unknown as ...` / narrow types). `load` default `Record<string, any>` in web-t32.server is a type parameter default, not a cast; acceptable.
- Money/order (billing acct1, printcfg1, uilist2.invoices, nav-complete.billing; frontdesk regscreen/fd-t14): no emitted value, rounding, status or SQL changed; edits are casts, `satisfies SpecRow[]` and the msw key only. No assertion changed or weakened.
- Tenant isolation / RLS / permissions / idempotency / rate tier / error codes: not touched by this diff (test typings only). No PHI (synthetic fixtures only), no secrets.
- Checks I ran: `tsc --noEmit -p apps/web` -> 0 errors under features/{catalog,frontdesk,billing}, 198 elsewhere (other tasks; matches notes). vitest vg6 7/7, web-t32 107/107, web-t35 96/96 (CI=true).
- Not verified by me: the remaining listed suites (acct1, regscreen1/2, etc., reported green in notes); `turbo run typecheck --continue` whole-repo before/after counts not re-run (notes record apps/web 88 -> 0 in scope).
