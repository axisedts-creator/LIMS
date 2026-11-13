# T0D-UI-R02 impl (LD-140, CR-UI-R-001)
Files: packages/ui/package.json (+ devDep `@fontsource/plus-jakarta-sans` 5.3.0 exact), pnpm-lock.yaml; packages/ui/assets/fonts/plus-jakarta-sans-latin-{400,500,600,700}-normal.woff2 + fonts.css (4 faces) + OFL-PlusJakartaSans.txt; packages/ui-flutter/assets/fonts/PlusJakartaSans-{Regular,Medium,SemiBold,Bold}.ttf (made with `python -I tool/woff2ttf.py` from the pinned latin .woff) + OFL-PlusJakartaSans.txt; pubspec.yaml family `Plus Jakarta Sans` 400-700.
[CONV] devDependency like the existing Noto @fontsource pins (assets are copied, not imported at runtime). OFL file = package LICENSE copied verbatim. woff2ttf.py unchanged.
[CONV] pnpm add reported ERR_PNPM_IGNORED_BUILDS for @scarf/scarf (telemetry postinstall of @fontsource); left ignored on purpose, lock and node_modules updated fine.
Tests: R02 suite 26/26 pass; full packages/ui vitest 1154/1154 (an earlier run had 2 x 5s timeouts in unrelated files under machine load; re-run clean); typecheck clean.
Open: flutter not run (no dart test); fonts.css still declares Noto Sans latin faces (kept, harmless, not in the sans stack).
