# T0D-UIX-2 impl (review round)
- Removed scratch copies apps/web/.uix2-forkB (outside owned paths).
- density="compact" -> "regular" at all 10 catalog DataTable sites (done_when 1); UnitsScreen first column isRowHeader (react-aria warning gone).
- [CONV] PriceCompare guarded() and PriceListDetail save: a press within 500 ms after a run ends is ignored, as PriceListTools.tsx:40. Fixes the 409 double-save (regression; passed at base) and Export CSV double download (also failed at base).
- Added notes/T0D-UIX-2-screens.md.
- Run: uix2 7/7, cattests1 40, catunits1 20, testmgmt1 141, emptytbl2 48, uilist3 173, web-t31 125, web-t32 107, web-t34 116, web-t35 96 green; tsc: no errors in catalog components.
- OPEN (tester/lead): testfix1 2 fail: kit EmptyState holds one action, so "Import from Excel" cannot sit in the DataTable empty row next to New test without a packages/ui change (not owned); pricetools1 3 fail: tests still pin lims-table-compact, contradicting done_when (1) and pricetools1.source. See notes/T0D-UIX-2-left.md.
- Pre-existing, untouched: web-t33 createDoctor, rs-c3, testimport1, web-t38, emptytbl1 (not re-run this round).
