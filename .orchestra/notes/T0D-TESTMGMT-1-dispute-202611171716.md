# T0D-TESTMGMT-1 dispute (writer) — 1 test, self-contradictory
Test: testmgmt1.screens.test.tsx > Notes (item 6) > "New comment code has Type, Default template and Text format; the request carries them".
It requires a control labelled /^text format/i AND, in the same dialog, `within(dlg).getByLabelText(/^text/i)` to return ONE element (the Text box).
Any label matching /^text format/i also matches /^text/i, so getByLabelText throws "Found multiple elements" (proved with kit TextArea "Text" + kit Select "Text format").
web-t33.components (existing, green) uses the same `getByLabelText(/^text/i)` on this dialog, so the label cannot be "Text format" without breaking web-t33.
Implemented: Type, Default template, and the text format control labelled "Format" (plain | markdown, sent as text_format). Every other assertion of the test holds.
Ask: change the test's label regex to /^(text )?format/i (or query the Text box with /^text$/i). No other test is disputed.
Also note (not disputed, weak assertion): range-manager "Sex robot / Age Unit decade" regex /hour.*day.*week.*month.*year|age unit/i also matches the "Age Unit" column header, so the age-unit message is worded "Unit must be year, month, week, day or hour" to keep findByText single.
