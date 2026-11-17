## Debug round (2026-11-17)
- Cause: verify failed only on rs-c2.screens "s4 master centres" new-unit tests (admin, not touched by this task). Log durations 142 s and 6245 s against a 30 s timeout: host stall/load, not a defect. All catalog tests (138/40/20) and rs-c2.static passed.
- Evidence: `git diff cc435db31^..HEAD -- apps/web/src/features/admin apps/web/src/features/platform` is empty; rerun of the "s4 master centres" block: 6 passed in 16.8 s.
- Fix: none needed in code. Re-run verify.
