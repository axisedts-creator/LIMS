CHANGES
Scope checked: c757b2c7..HEAD (golden regen + removal of test/failures artifacts) against done_when / 10-DESIGN-SYSTEM s5 / LD-140. Goldens status_chips.png / cr16_widgets.png reflect only the R05 restyle. Stale test/failures/*.png deleted. No lib/ changes, no API/route/permission/PHI/secret changes. Re-checked at HEAD c208d5bd: no tester commit since the last review, so the open item is still open.
1. TESTER: the ignore rule is still missing (no packages/ui-flutter/.gitignore; root .gitignore has no `failures` entry), so a future failing golden run will again drop committable artifacts in packages/ui-flutter/test/failures/. Fix: create packages/ui-flutter/.gitignore containing the single line `test/failures/`.
WRITER: no change.
