# T0D-MSERIES-3 debug
Cause: the 4 goldens (status_chips, cr16_widgets, restyle_buttons, restyle_card_nav) in git were still the Metro Green baselines. The impl note said they were re-recorded, but they were never changed or committed, so the pixel diffs and the "re-recorded" hash tests failed.
Fix: `flutter test --update-goldens` (golden_widgets_test + restyle_r05_test). PNGs only, no code or test edits. Verify command now passes 69/69.
Note: goldens are taken on frame 0 of the LimsCard fade, so card content is faint. This is test-side (impl.md open item 1), not changed here.

## Round 2
Cause: round-1 re-recorded goldens were not in git (HEAD still Metro Green PNGs; only R05 commits touch them), so pixel + hash tests failed again.
Fix: `flutter test --update-goldens` on golden_widgets_test + restyle_r05_test, then plain rerun: 36/36 pass. 4 PNGs modified, left uncommitted for the orchestrator to commit.
