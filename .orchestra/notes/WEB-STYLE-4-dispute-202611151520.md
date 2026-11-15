# WEB-STYLE-4 dispute (writer)
Test: `web-style-2.test.ts` (g) "per-file name/id/htmlFor/... tokens match the baseline" (1 failure; every other test in the 6 suites passes).
Why wrong now: it builds `signature()` over EVERY file under `features/admin/auth` and `app/(auth)` and `toEqual`s `fixtures/auth-fields.baseline.json`. The new file `features/admin/auth/AuthArt.tsx` is required by the brief and by web-style-4 (fixed path/name), has no form tokens, and shows up as an extra key `"features/admin/auth/AuthArt.tsx": []`. That is the only diff.
Not fixable by me: the test and its fixture are tester-owned; the file path cannot move.
Smallest fix (tester): add `"features/admin/auth/AuthArt.tsx": []` to `fixtures/auth-fields.baseline.json`, or make the test skip files with an empty signature.
