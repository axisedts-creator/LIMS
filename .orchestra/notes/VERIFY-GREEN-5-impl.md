# VERIFY-GREEN-5 impl (writer)
- Changed: apps/web/tsconfig.json only: `paths "@/*": ["./src/*", "../portal/src/*"]` (portal fallback, web first). No portal file touched.
- Cause: web tsc program pulls portal pages in; `@/` resolved to web src only. Modules EXIST in apps/portal/src: wrong alias, not a missing feature. No stub (LD-250). TS2307 x7 + TS7006 x2 gone (TS7006 was a consequence).
- [CONV] Relative-specifier fix tried first and rejected: rs-c6.static pins page/actions.ts hashes and `@/…#sym` import keys; it failed 2 tests. Alias fix keeps them green.
- No emitted value, rounding, status or SQL changed (tsconfig `paths` is type-resolution only; Next build also reads it, resolves web first, so no existing import changes target). No money/order code touched.
- Counts (`tsc -p`, not full turbo): web 290 -> 285, portal 0 -> 0. Remaining 285 are test files (incl. src/features/homecollection/tests/e2e/HC-T30.nightly.spec.ts:28 TS2532 x2, an e2e spec = test file, not edited).
- Ran green: vg5 17/17, rs-c6 3 files 60/60 (with CI=true), web-build-2 37/37.
- Not run: full `turbo run typecheck --continue`, web build, whole web unit suite.
- Open: confirm HC-T30 .spec.ts counts as a test file for the done_when; `next build` not run to confirm alias fallback.
