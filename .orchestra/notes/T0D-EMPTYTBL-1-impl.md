# T0D-EMPTYTBL-1 impl (writer) — 13 files
Kit: packages/ui DataTable.tsx (new `EmptyRow` + `PlaceholderRows`; DataTable empty state adds 4 inert div placeholders in its cell), kit.css (`.lims-row-placeholder` pointer-events:none, faint border).
Screens: catalog master-ui (MasterTable), PriceListsList (+ New price list in the row), TestsList; reporting SimpleTable (select-all disabled when empty); lab CriticalValueList, IngestExceptionList, QueueScreen (Verify button / select-all hidden when empty), StatusBoard, WorklistPage, PendingPage; anatomic TrackingScreen (sent-out uses DataTable empty state).
[CONV] placeholders sit in an aria-hidden `<tfoot>` after `</tbody>` so the body keeps exactly one message row (CATTESTS-1/CATUNITS-1 tests count `tbody tr` = 1); in kit DataTable they are divs inside the empty cell (react-aria owns the rows).
Loading/error branches untouched (worklist/pending render the table only once `load.s === 'ok'`).
Results: emptytbl1 28/29 (Doctors: test grants nonexistent `catalog.doctor.manage`), cattests1 40/40, catunits1 20/20, web-t31/32/33/35/38, reporting c6-t31/rs-c6, anatomic t20–t26, lab c5-*/lab-t10/25/26/29/30 green.
Disputes (.orchestra/notes/T0D-EMPTYTBL-1-dispute.md): Doctors perm; web-t34:151 two "New price list" buttons; lab-t27:79 expects no table; ui-r03 DataTable snapshot re-record.
Pre-existing, files untouched: rs-c3/rs-c5 baselines, adminpage-lab-1 contracts, lab-t11 LabelPage innerHTML, anatomic t19 nav, packages/ui font + R07 tests. New test files may shift rs-c3 hash list (re-record).
