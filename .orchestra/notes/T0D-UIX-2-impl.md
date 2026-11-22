# T0D-UIX-2 impl (review round)
- Removed scratch copies apps/web/.uix2-forkB (outside owned paths).
- density="compact" -> "regular" at all 10 catalog DataTable sites (done_when 1); UnitsScreen first column isRowHeader (react-aria warning gone).
- [CONV] PriceCompare guarded() and PriceListDetail save: a press within 500 ms after a run ends is ignored, as PriceListTools.tsx:40. Fixes the 409 double-save (regression; passed at base) and Export CSV double download (also failed at base).
- Added notes/T0D-UIX-2-screens.md.
- Run: uix2 7/7, cattests1 40, catunits1 20, testmgmt1 141, emptytbl2 48, uilist3 173, web-t31 125, web-t32 107, web-t34 116, web-t35 96 green; tsc: no errors in catalog components.
- Review round 2: both items were tester-owned (done). Re-run 11:44: uix2 7/7, pricetools1 193/193, testfix1 122/122. No catalog __snapshots__, nothing to regenerate (LD-443). No implementation edit needed.
- Pre-existing, untouched: web-t33 createDoctor, rs-c3, testimport1, web-t38, emptytbl1 (not re-run this round).
