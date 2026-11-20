# T0D-OFFLINE-3 dispute (writer, 2026-11-20 07:15 NPT)

Review file absent; LD-431 says WRITER nothing. Ran every config in T0D-OFFLINE-3-verify.cmd individually.

GREEN: offline3 88, offline2 140, offline1 82, fd-t13 70, fd-t14 98, fd-t17 18, regscreen1 75, rs-c4 37, adminpage-fd-1 45, bl-t20 54, bl-t23 25, lab-t10 34, c5-t20 57, rs-c2 74.

RED (7), all in lab guards. `git diff main...HEAD -- apps/web/src/features/lab "apps/web/src/app/(staff)/lab" contracts` is EMPTY
(merge base = main tip 753f62f), so none is an OFFLINE-3 defect; all come from main-landed work (same family as LD-391..431):
1. lab-t11.static "no dangerouslySetInnerHTML": features/lab/components/labels/LabelPage.tsx:160 `dangerouslySetInnerHTML={{ __html: html }}` (label print region, last touched 4ad29eaa4 / PRINTCFG-1 area). Real security question (S-09) for the owner of LabelPage, not a list patch.
2. rs-c5.static "features/lab/server/** byte-identical": 11 files vs baseline 10 (one server file added on main).
3. rs-c5.static "(staff)/lab page routes unchanged": 18 vs baseline 16.
4. rs-c5.screens "worklist ... right panel" snapshot mismatch.
5. adminpage-lab-1.static "only those two rows added to routes.yaml": 12 rows vs 2 expected.
6. adminpage-lab-1.static "permissions.yaml and openapi/* byte-identical": contracts/openapi/analytics.yaml (and more) differ from frozen BASE.
7. adminpage-lab-1.worklists "department index": "Found multiple elements with the text: HAEM" (screen changed on main).

ASK (lead): rule TESTS_WRONG/frozen-baseline for 2,3,5,6 (LD-431 style line-subset check), assign 4 and 7 to the lab owner
(rs-cN snapshots are writer-owned per LD-430, but OFFLINE-3 does not own lab screens), and route 1 to the PRINTCFG-1/label owner
as a security review. WRITER: no code change; stopped.
