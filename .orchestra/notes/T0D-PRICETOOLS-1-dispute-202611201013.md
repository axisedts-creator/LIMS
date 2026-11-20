# T0D-PRICETOOLS-1 dispute (writer)

Test: pricetools1.source.test.ts > "no page, route or layout file was added for the tools ... no compare / copy / bulk / template folder".

Why it is wrong: it fails on `apps/web/src/app/(staff)/catalog/import-templates`, a folder that existed before this task (added by commit 7b0106219 "[writer] T-35 impl", the catalog import templates screen). This task adds NO folder under app/(staff)/catalog (git status: only the two existing price-lists page.tsx files are modified). The regex /template/i matches the old folder name.

Proposed fix (tester): exclude pre-existing folders, e.g. `dirs.filter((x) => /compare|copy|bulk|template|upload/i.test(x) && x !== 'import-templates')`, or compare against the folder list on main.

Everything else: 192 of 193 pricetools1 tests pass.
