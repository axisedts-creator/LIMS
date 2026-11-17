# VERIFY-GREEN-6 impl (writer)
- Files: 19 test files (catalog 12, frontdesk 6, billing bl-t20) `listen({onUnhandledRequest})` → `onUnhandledFrame` (msw 3.0.3 renamed it; old key was silently ignored, so 'error' is now really enforced; all suites still green) [CONV].
- web-t32.server: `load` default generic `Record<string, any>` (35 TS2722 + 2 TS18048 gone). t32.components: `res as Record<string, unknown>`. t33/t34.components: `ord()` return type annotated. t35: `| undefined` on optional `form`/`filename` (exactOptionalPropertyTypes), `vi.fn(async (..._a: unknown[])`.
- tsc apps/web errors under features/{catalog,frontdesk,billing}: 65 before, 0 after. Other dirs untouched (other tasks); whole-package turbo count not re-run.
- Money/order: no emitted value, rounding, status or SQL changed; only test files, no product file; no ts-ignore/`as any`/skipLibCheck added.
- Run green: vg6 gate 7/7; catalog t31 125, t32 107, t33 103, t34 116, t35 96, rs-c3 25; frontdesk fd-t13 70, fd-t14 98, rs-c4 36, adminpage-fd-1 45; billing bl-t20 54.
- Open: no runtime question, no CR needed. Same msw rename still pending in other dirs (engagement, quality, shell).
