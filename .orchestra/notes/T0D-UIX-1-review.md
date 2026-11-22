APPROVE

Round 2 (HEAD b9b6733a5):
- Round 1 item 1 is fixed. `.orchestra/notes/T0D-ELABMENU-3-table.md` now matches ecda4cc4c exactly (`git diff ecda4cc4c..HEAD` on that file is empty).
- shell.css block: DONE WHEN 1-6 values are set with tokens only (radius-sm = 8px, space-1/2/3/6/8, neutral-0/50/100/200/300/600/700/900, accent, accent-fg). There is no hex and no new !important, and every rule is scoped to .lims-shell. The .lims-align-start rule has been added.
- Cascade checked against kit.css: `.lims-shell .lims-table th` (0,2,1) beats the sticky `thead th` white background (0,1,2). Row hover (neutral.50), selected row (accent.subtle) and tabular-nums come from kit rules that still apply. The date icon rule (0,4,0) beats the IconButton rule.
- kit.css, tokens.json and layout.css are unchanged, and the LD-344/352 sidebar values are kept. The change is display only, with no route, permission, API or contract change. Nothing touches PHI or secrets, and RLS does not apply.
- Tests run by the reviewer: uix1 63/63 passed. Shell configs passed: uikit2 59, unslop1 30, elabmenu 99, density 350 (+2 skipped), m4 330, m2 324 and r04 76. packages/ui m-series-kit + ui-r03-kit-pass 177/177 passed.
- Leftovers are recorded in T0D-UIX-1-left.md: portalled dialogs are outside .lims-shell, and there was no real-browser pixel check.
