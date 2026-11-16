# T0D-MSERIES-4 impl (LD-266)
- Changed: apps/web/src/core/shell/shell.css — `.lims-rail-search` gets `flex: none` (with LD-266 comment); nothing else touched. kit.css untouched.
- Survey: .orchestra/notes/T0D-MSERIES-4.md (only the rail had a definite-height column parent holding a field).
- [CONV] Compact density: kit `[data-density='compact'] .lims-input` (0,2,0) beats `.lims-rail-search` (0,1,0), so 40 px still applies.
- Verified: build:nav + vitest.m4 config, 17 files / 322 tests passed.
- Open: cause not confirmed in a real browser; Playwright spec tests/e2e/shell/T0D-MSERIES-4.shell.spec.ts needs a stack (not run in lane).
