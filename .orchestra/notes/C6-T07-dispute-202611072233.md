# C6-T07 dispute (writer) — 1 test

Test: `lab-report.test.ts` > "nominated mode: ... approvers stay in the department "Approved by" line", last assertion
`expect(pages[0]).toContain('Approved by: Dr. Synthetic Signatory A')`.

Why it is wrong: the fixture is `multi()` = ONE department (HAEMATOLOGY) of 3+ pages (CBC + 140-line bulk panel). PRD AC-03.7
says approvers are listed in the **per-department** "Approved by" line, and 04-UI-UX §3.1 draws that line at the end of the
department, after its panels. The template prints it once, after the department's last panel, which is on the last page,
not page 1. The assertion only holds if the line is printed after the first panel (arbitrary) or after every panel (not
"per department").

Proposed fix: assert on the page that holds it, e.g. `expect(pages.some((p) => p.includes('Approved by: Dr. Synthetic Signatory A'))).toBe(true)`
(or `pages.at(-1)`). Everything else in that test passes (nominated signatory + disclaimer on every page).
Result now: 121 passed, 1 failed (this one), 1 skipped (Devanagari host fonts, pre-existing).
