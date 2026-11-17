# AN-T01 dispute (writer)
Test: `services/api/src/modules/analytics/__tests__/boot.test.ts` > "in staging/production a stub never answers 501: it rejects with common.internal" (line ~102-111).
Defect: `withEnv` calls `vi.resetModules()` then dynamically imports `../index.js`. The reset also re-instantiates `core/errors.js`, so the stub throws a `LimsError` of the NEW class, while the test's statically imported `isLimsError` checks `instanceof` against the OLD class -> always false, for any implementation importing `errors.js` from src.
Evidence: probe (deleted) printed `name=LimsError code=common.internal isLimsError(e)=false`. Stub does reject with code `common.internal`; stub dev 501 test passes.
Result: 116/117 pass in boot.test.ts; worker 10/10; web 6/6. Only this one test fails.
Fix options (tester): compare `e.code === 'common.internal'` / `e.name === 'LimsError'`, or import `isLimsError` dynamically after `resetModules` in the same registry.
Writer did not hack class identity (globalThis/Symbol.hasInstance) to satisfy it.
