# H80-T07 tests (tester)
- File: `tests/docs/H80-T07.commissioning.test.mjs` (node:test, reads `docs/manual/instruments/truth-h80e-commissioning.md`; no fixtures needed).
- Run: `.orchestra\notes\H80-T07-verify.cmd` (= `node --test tests/docs/H80-T07.commissioning.test.mjs`). Fails now: runbook file does not exist.
- Format the writer must follow (assumed, header of the test): headings `## Step 1` .. `## Step 9` in addendum §9 order; each U item = a line naming it, with a blank `____` on that line or the next 2 lines, labelled "Observed"/"Record".
- Checks: nine steps in order; per-step content from §9 (static IP, LIS address, [Apply]→[Set]→[Lis], tcp_server, 5 patient + 2 QC, QCK OK/DSR/ACK^Q03, NF cases, Devanagari, offline, verified/c7-driver-registry-check/aal2); 16 U-item blanks; vendor engineer vs lab staff; sign-off blanks; sentences ≤ 40 words; synthetic data, no secrets/real phone numbers; no invented DSR test list (LD-139).
- Not tested: wording quality beyond these checks (needs a human read-through); no ACs in 07-SECURITY apply to a doc.
