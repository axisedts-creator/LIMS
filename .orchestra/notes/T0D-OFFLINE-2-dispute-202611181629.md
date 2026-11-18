# T0D-OFFLINE-2 dispute (writer, 2026-11-18, against LD-384)

No file changed. LD-384 fix (remove `lims-sway` only) cannot make the tests green; stopped as the inbox rule says.

1. r04.source.test.ts:139 fails on EVERY duration > 450 ms in shell.css, not only sway. Measured with the test's own regex
   (stripped shell.css): lims-sway 14s, lims-wave 5.6s, lims-bob 6s (x2), lims-ring 3s, animation-duration 7.5s and 5.4s,
   animation-delay -2s and -1s (regex also counts delays). Removing sway only moves the failure to `expected 5600 <= 450`.
2. features/admin/auth/__tests__/m5.entry.test.tsx:347-355 ("the four looping animations exist (plate sway, ...)") REQUIRES
   `.lims-auth-plate` (and well, chip, mark-ring) to have an `infinite` animation naming a defined @keyframes. Removing sway
   turns m5.entry red. r04 (cap 450 ms on all shell.css motion) and m5.entry (4 endless decorative loops in shell.css) contradict each other
   while the auth CSS lives in core/shell/shell.css.
3. Side note: m5.entry fails to load under the default `npx vitest run` (cannot resolve `@/app/(auth)/layout`); needs its own config.

Options for the lead (one ruling needed, writer does not pick since tests and pinned files are involved):
- A. Move the auth-plate CSS out of core/shell/*.css (e.g. app/(auth) CSS) so r04 does not scan it. Touches app/(auth), pinned by rs-c2.static.
- B. Remove all 9 long animations (sway, wave, bob x2, ring, chip, delays) and change m5.entry's "four looping animations" test (tester role).
- C. Narrow r04's motion test to non-auth selectors (tester role; LD-384 says the test is right, so likely not).
