# Dispute T0D-OFFLINE-3 (debugger, verify 07:23)
Failing: src/features/lab/__tests__/lab-t11.static.test.ts:107 "no dangerouslySetInnerHTML ..." scans ALL of features/lab, hits components/labels/LabelPage.tsx (T-10, commit 4ad29eaa4, already on main).
Contradiction: lab-t10.static.test.ts:60-62 explicitly ALLOWS up to 2 dangerouslySetInnerHTML in the page component (renderer output / print region). Two tests of the same tree disagree.
Not OFFLINE-3: `git diff main HEAD -- apps/web/src/features/lab` is empty; this task touches no lab file. Fails identically on main.
Needs lead ruling: tester narrows lab-t11 own() to exclude components/labels (T-10 print region), or T-10 owner changes LabelPage.
