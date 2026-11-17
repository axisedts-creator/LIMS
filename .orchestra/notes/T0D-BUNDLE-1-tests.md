# T0D-BUNDLE-1 tests (tester)
- Files: apps/web/src/core/__tests__/bundle-budget.test.ts + vitest.bundle-budget.config.ts. Run: `.orchestra/notes/T0D-BUNDLE-1-verify.cmd` (also re-runs web-build-1/2 guards).
- Contract pinned in the test header: `node scripts/bundle-budget.mjs <buildDir> [--budget f]`, reads `<buildDir>/build-manifest.json` (rootMainFiles, polyfillFiles, pagesChunkGroupBootstrapParams[route].otherChunks); gzip KB (1024); exit 0 pass / 1 over / 2 usage-config-missing-file; rows say `ok`/`OVER`, summary `PASS`/`FAIL`.
- Budget file `apps/web/scripts/bundle-budget.json`: first_load_js_kb 170, route_extra_js_kb 60, css_kb 40, requests 25, entry_routes[], overrides{route:{..., todo "YYYY-MM-DD"}}.
- Fixture builds are generated in os tmpdir (no build needed). Covers: boundary 170/171 KB, gzip not raw, dedupe, extra-JS rule, CSS, 25/26 requests, overrides need dated todo, bad input => exit 2, missing chunk/entry route => exit 2.
- Static guards: package script calls bundle-budget.mjs; next/dynamic used in features/ (not admin/platform) and every dynamic() has `loading:`; no icon-barrel `import *`; no polyfill deps.
- NOT tested: real-build sizes (needs `next build`; the 298 -> <=170 KB result is for the writer's notes), no-behaviour-change, "no edit under admin/platform" (reviewer diff check). Expected now: all fail (script/budget missing).
