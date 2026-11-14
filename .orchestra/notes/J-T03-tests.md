# J-T03 tests (US-BL-16.1, c04-copy-scan)
- File: `tools/lint/tests/copy-scan.test.mjs` (node:test; runs shipped `apps/web/src/features/billing/__tests__/copy-scan.mjs` copied into temp mini-repos).
- Covers: 5 banned phrases x 6 scan roots, case variants, file:line report, allowed copy, __tests__/other-chunk exemptions, empty-scan guard, branch-protection requires c04-copy-scan, real repo clean.
- Run: `.orchestra\notes\J-T03-verify.cmd`
- Fails now (4 tests, 48 pass): scanner is line-by-line / single-space, so "IRD\napproved", "approved by\nIRD", "IRD  approved", tab, nbsp, wrapped JSX slip through. Fix = whitespace-tolerant multi-line match in copy-scan.mjs.
- Not tested: message-catalog path (spec names none; core/i18n/messages.ts is shared by all chunks) - lead to decide via CR if catalogs must be scanned.
