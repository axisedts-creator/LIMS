TESTS_WRONG — `lab-report.test.ts:313` asserts the department "Approved by" line is on page 1; the spec puts it at the end of the department, which for the `multi()` fixture is the last page.
Change the test: replace `expect(pages[0]).toContain('Approved by: Dr. Synthetic Signatory A')` with
`expect(pages.at(-1)).toContain('Approved by: Dr. Synthetic Signatory A')` (optionally also assert it appears exactly once across `pages.join('')`). Keep the per-page disclaimer/NHPC loop unchanged.
Reasons:
- spec/chunks/C6-reporting-delivery/01-PRD.md:141 (AC-03.7) — approvers "are still listed in the per-department 'Approved by' line": one line per department, no page placement required.
- spec/chunks/C6-reporting-delivery/04-UI-UX.md:232-233 (§3.1) — "Approved by" is drawn after the department's panel(s) and specimen line ("panel end"), i.e. the department's tail, not its head or every page.
- spec/chunks/C6-reporting-delivery/04-UI-UX.md:168 — config toggle is "Show 'Approved by' per department", confirming once-per-department semantics.
- Fixture `multi()` (lab-report.test.ts:22) = one HAEMATOLOGY department spanning CBC + 140-line bulk panel (3+ pages), so the tail is on the last page.
- Implementation (services/renderer/src/templates/lab/index.ts:41) emits the line once after the department's last block — matches spec. No implementation change.
