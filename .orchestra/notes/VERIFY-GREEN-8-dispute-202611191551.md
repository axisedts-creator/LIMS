# VERIFY-GREEN-8 dispute (debugger, 2026-11-19)
All 3 gate failures (vg8.typecheck.test.ts) are in test files; no product file is involved, and the debugger may not edit tests.
1. Test 1 (line 56): 65 x TS2883 in `*.harness.tsx` / `*.helpers.tsx` / `rs-c15.fixtures.tsx` (inferred `router`/`navigationMock`/`show`/`wrap`... cannot be named). Fix is explicit return-type annotations in test helpers: tester-only edit, runtime unchanged. Not a product bug.
2. Test 2 (line 77): `apps/web/src/__tests__/sec-hyg1.pollers.test.tsx:157` has `(p.fail ? it : it.skip)(...)`, a SEC-HYG-1 conditional skip. The gate regex `\b(it|test|describe)\.(skip|todo)\b` flags it and its allowlist (line 75) names only vgN, build-config, HC-T30. Gate vs SEC-HYG-1 test contradict; lead must decide (allowlist the file or restate the poller test without `it.skip`). I did not touch either.
3. Test 3 (line 82): `as any` total outside vgN files exceeds BASELINE_AS_ANY=66 (log: 90). Baseline predates later lanes' test files, or VG8 edits added casts. Lead must either re-baseline or have the tester replace casts with typed ones.
Spec line: task brief done_when, "No @ts-ignore, @ts-expect-error, `as any` ... added"; counted against a stale baseline (66).
Stopping: no implementation fix exists.
