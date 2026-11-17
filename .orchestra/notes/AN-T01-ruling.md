TESTS_WRONG — the test asserts class identity across two module registries, which no spec line requires; the stub's observable behaviour already matches the spec.
Reasons:
- spec/chunks/C8-analytics-mis/06-IMPLEMENTATION-PLAN.md:11 requires only "501 only in dev via core stub"; spec/program/02-CONVENTIONS.md:416,936 require unknown/unimplemented failures to surface as `LimsError` code `common.internal`. Impl (handlers/index.ts:20-21) throws `new LimsError('common.internal', …)` outside dev — compliant.
- Reproduced: boot.test.ts:108 fails (116/117 pass). Cause is test harness: `withEnv` calls `vi.resetModules()` then dynamically imports `../index.js`, so the stub's `LimsError` comes from a fresh `core/errors.js` instance, while `isLimsError` (static import, line 19) does `instanceof` against the old class (core/errors.ts:39). False for any compliant implementation.
- Spec forbids nothing here that would justify a globalThis/Symbol.hasInstance hack in the impl; the writer correctly declined.
Change in test (boot.test.ts, test at lines 102-111), pick one:
  (a) inside the loop, after `withEnv(env)`, do `const { isLimsError: isLE } = await import('../../../core/errors.js');` and assert `isLE(out.e, 'common.internal')` (same registry — preferred, keeps the type check meaningful); or
  (b) assert `expect(out.e).toMatchObject({ name: 'LimsError', code: 'common.internal' })`.
Keep the `out.ok === false` (never resolves / never 501) assertion unchanged.
