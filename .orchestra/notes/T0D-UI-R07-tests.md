# T0D-UI-R07 tests
- File: `packages/ui/scripts/__tests__/no-raw-style-literals.test.ts` (scanner + tests in one file; LD-140; 10-DESIGN-SYSTEM s7/s8).
- Run: `.orchestra/notes/T0D-UI-R07-verify.cmd` = `pnpm --dir packages/ui exec vitest run scripts/__tests__/no-raw-style-literals.test.ts`
- Passing now (38): detector unit cases (hex, rgb/hsl, px radius css/ts/dart, `style={{`, comment/`&#123;`/var() non-hits), planted-literal scratch tree must fail, generated `*.g.dart` / node_modules / packages/ui excluded, pending match is per path segment.
- Failing now (4), right reason ENOENT: `raw-style-pending.json` missing (writer creates it). Then real-tree test shows any hit not covered.
- Writer contract for `packages/ui/scripts/raw-style-pending.json`: JSON array of repo-relative forward-slash dirs, one per line (`JSON.stringify(list, null, 2)`), each an existing dir under the 4 scanned roots, no duplicates, none under packages/ui. A dir covers its subtree.
- Scanned: .ts/.tsx/.js/.jsx/.mjs/.cjs/.css/.scss/.dart; skips node_modules, dist, build, .dart_tool, .next, coverage; comment-only lines ignored.
