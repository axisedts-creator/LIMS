# T0D-UI-R01 tests (Metro Green tokens)
Files (all under packages/ui): `tokens/__tests__/metro-green-values.test.ts` (new: exact s2.1-2.3 values, token-name set = old names + 4 additions),
`tokens/__tests__/contrast.test.ts` (s2.6 pair list, AA for every pair, spec-quoted ratios, accent.brand never text on light),
`scripts/__tests__/build-tokens.test.ts` (no-diff regen of tokens.ts/tokens.g.dart/tokens.css, new tokens in all three, poisoned-token + bad-alias rejection),
`src/theme/__tests__/accent.test.ts` (default #0E4B3B, dark fg = neutral.900, s2.6 pairs for default + #7B1E5A + #9A3412).
Run: `.orchestra/notes/T0D-UI-R01-verify.cmd` (pnpm --dir packages/ui exec vitest run ...). NOT executed here: worktree has no node_modules (needs `pnpm install`); contrast maths in the tests was cross-checked with plain node.
Assumptions: (1) `deriveAccent` dark fg becomes tokens neutral.900 `#13241D` (was slate `#0F172A`); (2) `DEFAULT_ACCENT` = `#0E4B3B`; (3) contrast-pairs.json keeps schema [{fg,bg,kind}], pairs may be declared in either direction, `critical.solid` pair = tone.critical.solid vs a token resolving to #FFFFFF.
Expected now: values, contrast, accent default/dark-fg, css/ts/dart new-token tests FAIL; poison/alias/dart-count/no-diff tests pass (regression guards).
Needs implementer: update tokens.json, contrast-pairs.json (s2.6 rows), accent.ts, rerun build-tokens (commit src/tokens.ts + tokens.g.dart).
