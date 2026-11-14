# Reference ranges and critical limits (SCR-08)

Route: `/catalog/tests/{test_id}?analyte={analyte_id}&tab=ranges` (or `&tab=critical`). Permission to view: `catalog.test.read`; publishing needs `catalog.reference_range.publish`.

## Purpose
Reference ranges decide the normal range printed next to a result and the High/Low flags. Critical limits decide when a result must be phoned to the doctor. Both are versioned.

## Versions
Each version is a chip with a status badge (Draft, Published, Scheduled, Superseded, Retired). "New version" copies the current one. You can edit a draft only; published versions are read-only. "Discard draft", "Publish…" and "Retire…" act on the selected version.

## Bands
Columns: Sex (Any/Male/Female) · Age from · Age to (exclusive) · Specimen type · Kind (Numeric/Text/Ordinal) · Low / High · Normal codes · Display text.
Lower age is included, upper age is not. Example: 0–18 years covers patients until the day before their 18th birthday.
A blank Age from means from birth; a blank Age to means no upper limit. Low must not be greater than High.

## Critical limits tab
The same columns plus Critical low · Critical high · Abnormal codes.

## Preview panel
Enter sex, age (or date of birth), specimen type and a date to see which band matches, for example "Matches band 2: Male, 18 years and over — 13.0 - 17.0 g/dL (version 3)". If nothing matches you see "No reference range".

## Publishing
Publish asks for Effective from, a change reason and a typed confirmation of the analyte code, because the change affects all future results. Requires two-step verification. Press `Ctrl+Enter` to confirm.
