APPROVE
Round 2. The r1 item is fixed: `.orchestra/cr/RS-C7.md` (CR-C7-RS01) follows the template and asks for agent heartbeat and queue depth on InstrumentSummary (E23). It is non-blocking, and the cards keep "Last message" until the CR is ruled. No code changed since r1 (c4a3ed98 touches only the CR and the notes).
Checked again: no change to API calls, forms, server, routes or permissions (the rs-c7.static baseline passes). No raw colour, pixel radius or inline style. The Sort-by RadioGroup offers only the two old sort values. The stepper's 5th "All checks done" step is [CONV] and fine.
Before merge: the lead must OK the web-t03 SCR-05 test edit (A5), and CR-C7-RS01 is still open.
Test runs (CI=true, this worktree, each suite with its own config): rs-c7 35/35, web-t03 98/98, web-t04 188/188, web-t05 171/171, web-t06 85/85. web-t02 failed 1/73 in a parallel run and passed 73/73 when run again (I did not capture the failing test's name).
Not run: eslint, tsc, a real browser.
