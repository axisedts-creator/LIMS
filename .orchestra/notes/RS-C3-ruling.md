TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- Fixture `rs-c3.screens.test.tsx:43` gives the container `name: 'Lavender tube'` and `cap_colour_display: 'Lavender'`. Both strings match `/lavender/i` in the same row, so `within(row).getByText(/lavender/i)` at line 173 throws "Found multiple elements" for every correct implementation.
- The container is a CodeName master with optional `cap_colour_display` (spec/chunks/C3-catalog-pricing/02-TRD.md:157; 05-SCHEMA.md:302). The Name column is existing behaviour. LD-140 (task brief) says restyles change appearance only, so the Name column must stay and the implementation cannot avoid the second match.
- No spec line requires that "lavender" appear only once in the row. 10-DESIGN-SYSTEM.md has no swatch or cap-colour rule beyond the task's done_when ("container colour shown as a swatch").
- Fix in the test, line 173: replace it with `expect(within(row).getByText('Lavender', { exact: true })).toBeTruthy();`. This still proves the colour name is shown as text next to the swatch, and it no longer matches the "Lavender tube" name cell.
- Keep the other assertions in that test unchanged (swatch present, no inline style, aria-hidden/label/role).
