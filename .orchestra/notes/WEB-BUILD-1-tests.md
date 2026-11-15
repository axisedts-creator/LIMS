# WEB-BUILD-1 tests (tester)
- `apps/web/src/__tests__/build-boundaries.test.ts` + `vitest.web-build-1.config.ts` beside it (static, no build, no network). Run: `.orchestra\notes\WEB-BUILD-1-verify.cmd` (vitest via root node_modules, config path).
- 8 self-tests with planted failures (virtual files) pass now: non-async export, hook via page/layout/route (2 hops, alias, namespace, re-export), 'use client' stops the walk, type-only/comment imports ignored.
- 8 repo guards: 6 FAIL now, right reasons: config.actions getLabSettingsAction/listDeltaRulesAction not async fns; shared.tsx useRef reached from labels page; DiffTable no 'use client'; useSerial not in a 'use client' file; NO_ACCESS module has hook. 2 pass (config bodies, labels import).
- EXTRA finding, not in the brief: guard also flags `packages/ui/src/components/PageShell/PageShell.tsx` (useId, no 'use client') reached from `(staff)/layout.tsx`. Impl: add 'use client' (mechanical, within LD-194 scope (4)); verify with the real build.
- Deviation: (a) accepts `export const x = async (...) =>` (27 catalog actions use it; Next allows it); only NON-async exports fail. Brief said "async function declarations"; strict form would force edits in catalog files outside scope.
- Not covered: real `next build`; existing lab/admin/ui suites staying green (reviewer/impl run them).
