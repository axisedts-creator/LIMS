# T0D-UIKIT-2 dispute (writer, 2026-11-21 21:40 NPT) — test vs test, web-style pins
Verify set is green (ui 230/230, web uikit2 config 59/59). But the pin web-style-3 named in done_when (6) is red, plus WEB-STYLE-1/2 in the same config:
`node node_modules/vitest/vitest.mjs run --config apps/web/src/__tests__/vitest.web-style-3.config.ts` -> 3 failed / 98 passed:
- web-style.test.ts "added lines have no hex, px, rgb()/hsl()", web-style-2.test.ts and web-style-3.test.ts "added lines: no hex, px, ..." -> `expected [ 'px value' ] to deeply equal []`.
Cause: the LD-438 card line in apps/web/src/core/shell/shell.css `.lims-card { border: 1px solid var(--lims-neutral-200) !important; ... }` is an added line vs the fixtures/shell.baseline*.css, and web-style-3.test.ts:66 allows only 296|76|46|20|3|2 px.
Conflict: apps/web/src/core/shell/__tests__/uikit2.shell.test.ts:42 requires exactly `'1px solid var(--lims-neutral-200) !important'` (and :58 allows only the 1px width). Writing `0.0625rem` (the existing rem hairline idiom, shell.css:48) satisfies web-style but fails uikit2.shell:42; keeping `1px` fails web-style. No implementation satisfies both.
Ask: either uikit2.shell.test.ts:42/58 accept `0.0625rem` (writer then switches the line), or the web-style pins allow 1px / the baseline fixture is refreshed. No implementation change made; stopped.
