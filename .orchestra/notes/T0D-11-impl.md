# T0D-11 impl
- Files: packages/ui/tokens/{tokens.json,contrast-pairs.json}, packages/ui/src/theme/accent.ts, packages/ui/scripts/build-tokens.ts; generated packages/ui/src/tokens.ts + packages/ui-flutter/lib/src/tokens.g.dart (committed; dist/tokens.css is gitignored). Outputs per 02-TRD line 1028.
- [CONV] `color.neutral.300` #CBD5E1 -> #8794A6 (3.08:1 on white; 04-UI-UX §1 says failing token is adjusted). Tone borders unchanged (decorative, not paired).
- [CONV] API `deriveAccent(input?: unknown) -> {accent,fg,subtle,link}` + `contrast()`, `DEFAULT_ACCENT`. Darkening = OKLab L -0.02 steps, a/b kept, channel clamp; terminates at black.
- [CONV] CSS names `--lims-<path>` minus `color.` prefix and `.default` suffix (so `--lims-accent`, `--lims-accent-fg`); Dart `LimsTokens.<camelPath>` (`Color`, `double`, `String`); build rejects values with url(/http/;{}<>.
- Ran `npx vitest@3 run packages/ui`: 29/30 pass; 1 fails = disputed subtle case (see T0D-11-dispute.md).
- Open: no package.json/tsconfig/eslint yet (T0A-01) so tsc+lint not run; `.gitattributes eol=lf` for tokens.g.dart needed or CRLF checkout breaks the equality test; failing-pair-blocks-build CI hook not wired.
