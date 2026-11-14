APPROVE
# T0D-UI-R02 review (diff dcdcb30d..HEAD)
- Scope: changed files are only the task's owned paths (fonts dirs, ui package.json, pnpm-lock, ui-flutter pubspec/assets) plus orchestra notes. woff2ttf.py was not changed.
- Pin: `@fontsource/plus-jakarta-sans` 5.3.0 exact in package.json and pnpm-lock (specifier, resolution and snapshot entries). Matches CR-UI-R-001 and 10-DESIGN-SYSTEM s2.2.
- Assets: the 400 and 700 woff2 files are byte-identical to node_modules @fontsource 5.3.0 `files/`. OFL-PlusJakartaSans.txt equals the package LICENSE and is the same in the ui and ui-flutter folders.
- fonts.css: 4 faces for 400-700, `font-display: swap`, relative URLs, no CDN. The token stack (`tokens.json`, `tokens.ts`, `tokens.g.dart`) is `"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif`, as s2.2 requires.
- pubspec declares family `Plus Jakarta Sans` with 4 TTF weights. The tests check that the TTFs are byte-identical to the `tool/woff2ttf.py` output.
- Tests: `vitest run assets/fonts/__tests__` passes 26/26 (I re-ran it). They cover no-egress/CSP, per-character Devanagari fallback and the Flutter asset declaration.
- Not a defect: s2.2 also mentions weight 800, but the task's done_when and the s2.2 weight scale both say 400-700, so following the brief is correct. Flutter `fontFamilyFallback` wiring is outside this task's files, so it belongs to a later restyle task. Flutter itself was not run.
- No PHI, no secrets, no invented names. RLS, permissions and idempotency do not apply to this task.
