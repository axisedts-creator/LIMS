# RS-C3 dispute (1 test)
Test: `rs-c3.screens.test.tsx` line 173, "container list shows the cap colour as a swatch plus its name…": `within(row).getByText(/lavender/i)`.
Why wrong: the fixture row is `name: 'Lavender tube'`, `cap_colour_display: 'Lavender'`. The Name cell (`<td>Lavender tube</td>`) and the cap-colour name both match `/lavender/i`, so `getByText` throws "Found multiple elements" for ANY correct implementation (it also failed this way before the restyle once a swatch existed; the Name column is unchanged behaviour and must stay).
Fix (tester): `within(row).getAllByText(/lavender/i).length >= 2`, or match the cap cell exactly (`getByText('Lavender', { exact: true })`).
Done on my side: swatch is `span.catalog-swatch` (aria-hidden, class-styled, no inline style) + the name text; the other 24 RS-C3 tests pass.
