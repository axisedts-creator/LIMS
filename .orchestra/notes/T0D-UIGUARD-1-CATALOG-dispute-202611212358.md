# T0D-UIGUARD-1-CATALOG dispute (writer)
Test: apps/web/src/features/catalog/__tests__/cattests1.tests-page.test.tsx:190 ("has the Departments/Doctors page pattern ... status filters").
It pins the OLD markup: `queryByRole('radio',{name}) ?? queryByRole('option',{name}) ?? queryByText(s,{selector:'label,button,span'})` for All / Active / Inactive.
TestsList now draws Status as a kit FilterBar select (LD-353 rule 2; uilist3.catalog.test.tsx:120 forbids a radio group in the filter row). A closed select shows no radio and no option, and "Active" also appears in the row status Badges, so getByText throws "Found multiple elements with the text: Active".
The behaviour test at line 346 (choose Status Inactive -> is_active=false) passes with the select. Done-when item 7 allows changing tests that pinned the old markup.
Ask (tester): check the Status control by label instead, e.g. `screen.getByLabelText(/^status/i)` or open it and look for the three options.

Test 2: unslop1.tables.test.tsx:93 "the Search button follows the search input directly". It walks `input.nextElementSibling ?? input.parentElement.nextElementSibling`, i.e. the old raw `<input>` + `<button>` markup. DoctorsList now uses the kit FilterBar (search box with type=search; the Search button is the next element of the field inside `.lims-filter-search`, LD-353 rule 2), where the input sits in `.lims-input-group` inside the field, so the walk finds nothing. Ask: look for the button as the next sibling of the input's `.lims-field` (or within `.lims-filter-search`).
The sibling test at line 79 (three radio groups) already fails on HEAD (T0D-UILIST-3 replaced the radios with selects); not caused here.
