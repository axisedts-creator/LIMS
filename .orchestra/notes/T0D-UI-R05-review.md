CHANGES
Scope checked: c757b2c7..HEAD (golden regen + removal of test/failures artifacts) against done_when / 10-DESIGN-SYSTEM s5 / LD-140. Goldens status_chips.png / cr16_widgets.png reflect only the R05 restyle. Stale test/failures/*.png (8 files) now deleted. No lib/ changes, no API/route/permission/PHI/secret changes. Verify set (T0D-UI-R05-verify.cmd) re-run by reviewer: 80/80 pass.
1. TESTER: previous item 1 only half done: the ignore rule was not added (no packages/ui-flutter/.gitignore exists and the root .gitignore has no `failures` entry), so a future failing golden run will again drop committable artifacts in packages/ui-flutter/test/failures/. Fix: create packages/ui-flutter/.gitignore containing the single line `test/failures/`.
WRITER: no change.
