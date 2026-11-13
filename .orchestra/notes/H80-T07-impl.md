# H80-T07 impl (writer)
- Files: `docs/manual/instruments/truth-h80e-commissioning.md` (new; only owned path).
- Nine `## Step N` headings in addendum §9 order; every U item has a `____` blank on a line labelled Record/Observed; sign-off has 3 blanks (lab manager, vendor engineer, date).
- [CONV] Every blank line ends with a period so the tester's 40-word sentence check does not merge list items.
- [CONV] LD-139: no DSR test list invented; host query stated inert until step 9 + reviewed migration.
- Tests: `node --test tests/docs/H80-T07.commissioning.test.mjs` = 35 pass, 0 fail. Full suite/lint not run (docs-only task).
- Open: wording quality needs human read-through; "5 patient + 2 QC" step 3 also asks to tick `manual_reference_confirmed` (my wording, not in §9 item 3).
- Review fix: step 1 now states `--allow-lan-listener` is required (no flag = no firewall rule, `link_state = error`), per reviewer wording. Re-ran tests: 35 pass, 0 fail.
