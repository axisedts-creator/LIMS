TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/program/13-M-SERIES.md:48 pins the source as `@fontsource/poppins` (published, >= 2 weeks old) and the subset as "latin 400, 500, 600, 700". No file-size floor appears anywhere in 13-M-SERIES.md (lines 47-49, 83, 88) or in LD-251.
- A losslessly unwrapped latin-only Poppins face is ~16 KB. The `> 20000` bound was a guess based on the Plus Jakarta Sans and Noto Sans sizes. It rejects valid assets that meet 13:48.
- Merging latin-ext to pass the bound would go beyond the subset 13:48 names. Fetching full TTFs from another source would break the pinned-source rule (13:48, LD-251).
- The point of the test is right: the files must be real TTF/OTF, not woff2 (Flutter cannot load woff2), and not stubs. The magic check at mseries3_test.dart:124-127 already enforces that.
Change in packages/ui-flutter/test/mseries3_test.dart:123: replace `greaterThan(20000)` with `greaterThan(10000)` and keep the reason text. Leave the magic check and every other assertion unchanged.
