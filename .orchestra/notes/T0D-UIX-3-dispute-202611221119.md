# T0D-UIX-3 dispute, round 3 (writer)
Ruling round 2 point 2b is done: IngestExceptionList.tsx now has 6 columns (Age, Barcode, Reason, Instrument code, Instrument, Status). Instrument is the IdText of instrument_id.
uilist1.lab is now green (76/76). But one test file pins the OLD 5 headers exactly, and 2 of its tests now fail (uiconsole1 config 257/259):
- apps/web/src/features/lab/__tests__/uiconsole1.lab.test.tsx:146 headers ['Age','Barcode','Reason','Instrument code','Status'] (tests "no rows" and "one row: the list header row is drawn and the age comes first").
- same file :227 (page test, same list) and the contract comment at :10.
These pins contradict uilist1.lab `min: 6` (kept by the ruling) and 04-UI-UX.md:224. Proposed test change (tester): insert 'Instrument' between 'Instrument code' and 'Status' at :146 and :227, and in the :10 comment.
The writer cannot edit test files, so the writer stops here.
