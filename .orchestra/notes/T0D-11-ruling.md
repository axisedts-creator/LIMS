TESTS_WRONG — `accent.subtle` is 8% accent + 92% white (a light tint), not 8% white + 92% accent.
Change in `packages/ui/src/theme/__tests__/accent.test.ts:67`: expect `deriveAccent('#000000').subtle` to be `'#EBEBEB'` (255 - round(255*0.08) = 235); fix the comment to match. Leave line 68 (`#FFFFFF -> #FFFFFF`) as is.
Reasons:
1. spec/chunks/C0-foundation-contracts/04-UI-UX.md:87 says "`accent.subtle` = accent mixed 8% with white". That means the accent is the 8% part (same as CSS `color-mix(accent 8%, white)`).
2. 04-UI-UX.md:30 sets the default `color.accent.subtle` = `#EFF6FF` with the role "selected row, active nav background". Mixing 8% of the default accent `#1D4ED8` into white gives `#EDF1FC`, which is close to `#EFF6FF`. The test's reading gives about `#2B5ADB`, a saturated blue that does not match the default.
3. 01-PRD.md:249 (AC-0D-8.1) requires every pair in contrast-pairs.json to pass AA, and that file includes `neutral.900` on `accent.subtle`. Under the test's reading, dark tenant accents would make that pair fail. Under the spec reading it passes.
4. The implementation (`packages/ui/src/theme/accent.ts:86`) follows the spec reading. No change is needed there.
