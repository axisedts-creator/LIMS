# T0D-UI-R05 debug
- Cause: committed goldens status_chips.png / cr16_widgets.png were byte-identical to the pre-restyle baselines (stale; 100% pixel diff vs the restyled render). Not an impl bug.
- Fix: `flutter test --update-goldens` on golden_widgets_test + restyle_r05_test (no test or impl code edited; only the 2 PNGs re-recorded).
- Verify set re-run: 80/80 pass. Left uncommitted for the orchestrator.
- Round 2: round-1 commit held only the note; the PNGs were never kept, so HEAD goldens were still stale. Re-ran `flutter test --update-goldens` (golden_widgets_test + restyle_r05_test): status_chips.png + cr16_widgets.png modified. Verify set 80/80 pass. PNGs left uncommitted.
- Round 3: HEAD goldens were still the stale pre-restyle bytes (tree clean at start; earlier regen never reached a commit). Re-ran `flutter test --update-goldens` (golden_widgets_test + restyle_r05_test): status_chips.png 6758->6841 B, cr16_widgets.png 4910->4925 B. 32/32 pass. PNGs must be committed with this note; I could not run git status/commit here (approval needed).
