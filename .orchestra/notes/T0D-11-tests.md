# T0D-11 tests (vitest; Node >= 22.18)
- packages/ui/tokens/__tests__/contrast.test.ts — AC-0D-8.1 (own WCAG oracle over contrast-pairs.json)
- packages/ui/src/theme/__tests__/accent.test.ts — AC-0D-8.2 (invalid/light/dark/mid-tone/property sweep)
- packages/ui/scripts/__tests__/build-tokens.test.ts — AC-0D-9.1 (tokens.g.dart regenerated == committed; css/ts emitted)
- Run: `pnpm --filter @lims/ui exec vitest run` (or `npx vitest run packages/ui`). Expected now: all fail (files/modules missing).
- ASSUMPTIONS (spec names none; writer must match or raise CR): export `deriveAccent(input?) -> {accent,fg,subtle,link}` (upper-case #RRGGBB);
  contrast-pairs.json = `[{fg,bg,kind:text|large|ui}]` with dot-path token refs; tone tokens end `<tone>.fg|bg`; build-tokens.ts runs with no args.
- Spec value neutral.300 #CBD5E1 is ~1.5:1 on white, so the UI-part pair fails until that token is adjusted (04-UI-UX §1 says that is intended).
- NOT run: vitest not installed (no package.json yet; T0A-01), so tests are unexecuted. "Failing pair blocks the build" case not covered (no CLI contract).
