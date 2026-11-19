# T0D-FAVICON-1 tests (tester)
- Test: apps/web/src/app/__tests__/favicon1.icons.test.ts (15 cases); config: apps/web/src/app/__tests__/vitest.favicon1.config.ts.
- Run: .orchestra\notes\T0D-FAVICON-1-verify.cmd (pnpm --dir apps/web exec vitest run -c src/app/__tests__/vitest.favicon1.config.ts).
- Proves: favicon.ico = 16/32/48, icon.png 192, apple-icon.png 180 (each <12 KB); manifest fields, colours present in tokens.json, 192+512 icons (512 file under app/ or public/, <40 KB).
- Proves: layout title {default 'Metro Labs', template '%s - Metro Labs'} + description, no explicit icons/manifest; brand folder untouched; no new route files in app/.
- Pins: the 512 icon src is a same-origin path resolving to a file in apps/web/src/app or apps/web/public.
- Expected now: icon files/manifest.ts missing, title still 'LIMS'. Generation note (Pillow/sharp) is the writer's; not testable here.
