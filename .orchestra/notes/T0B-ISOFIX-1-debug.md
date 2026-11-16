## debugger T0B-ISOFIX-1
- Cause: no code defect. Generator (db/tools/gen-isolation-probes.ts) already emits scope_all_centres = true; the 3 failing tests read the committed fixture files, which were never regenerated (tester step: node db/tools/gen-isolation-probes.ts).
- Fix: none in implementation code. Generator `--check` is green; ISOFIX tests 5/5 pass once fixtures are regenerated.
- NOTE: I ran the generator without --check by mistake, so 8 files in db/tests/fixtures/probe-rows are now regenerated in the working tree (uncommitted). My attempt to revert was denied. They equal generator output; tester should regenerate and commit them (or `git checkout` them first).
