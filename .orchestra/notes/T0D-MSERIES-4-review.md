APPROVE
T0D-MSERIES-4 review (diff 4fcfdc22e..HEAD, LD-266)
- shell.css: the only change is `.lims-rail-search { flex: none; ... }`, with an LD-266 comment. Width, colour, radius and focus are unchanged. kit.css is untouched.
- Compact density: kit `[data-density='compact'] .lims-input` (0,2,0) beats `.lims-rail-search` (0,1,0), so the field is still 40 px there.
- Tests: m4.source.test.ts statically asserts flex: none, that nothing re-enables growth, that kit.css and the rail layout are intact, and that the survey note exists. The Playwright spec checks the field height at 1280x800 and 1280x1400, the compact height and the pinned user card. Its selectors match Rail.tsx (type=search, aria-label Find a screen, data-testid user-card).
- Ran the verify command myself: 17 files, 322 tests passed.
- Paths: all are owned by C0 shell (src/core/shell, tests/e2e/shell per 01-CHUNK-MAP e2e/<module>). Data is synthetic. No secrets, PHI, DB, routes or new names.
- Not verified: the real rendered height in a browser. The Playwright spec needs a stack and has not been run. The cause is still unconfirmed in a browser, as the impl notes say.
