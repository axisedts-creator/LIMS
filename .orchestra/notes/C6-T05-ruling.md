TESTS_WRONG — the test helper `src/__tests__/helpers/pdf-text.ts` cannot extract text from a valid Chromium/Skia PDF. No test assertion is wrong, and the implementation is not at fault.
Reasons:
- spec/chunks/C6-reporting-delivery/02-TRD.md:990 requires "pixel-independent assertions via PDF text extraction". spec/chunks/C6-reporting-delivery/01-PRD.md:138 (AC-03.4) says "text extraction returns the same Unicode string (NFC)". Both require a correct extractor. Neither says the renderer must emit PDF structures that a naive regex can read.
- Reproduced: 14/47 fail. Failures are raw glyph ids, e.g. `expected '\u0000-\u0000\u0013…' to contain 'J0-P1'`. This means no ToUnicode CMap was applied. That matches defect 1: `inlineOrRef` uses non-greedy `<<[\s\S]*?>>`, so a nested `/Resources <</ExtGState <<…>> /Font <<…>>>>` is cut short at the first `>>` and `/Font` is never found.
- Defects 2 and 3 (each `Tj` joined with `\n`; `/ActualText` spans ignored) are also helper bugs. Standard extractors join positioned runs within a text block and honour ActualText for Devanagari clusters (PDF marked-content), so AC-03.4 extraction has to as well.
Tester must change `helpers/pdf-text.ts` only:
1. Make `inlineOrRef` scan balanced `<<`/`>>` pairs.
2. Concatenate the text runs inside one `BT…ET` block with no separator, or join them by position.
3. Replace each `/Span <</ActualText <FEFF…>>> BDC … EMC` with its ActualText string.
The writer's diff in C6-T05-dispute.md is acceptable. Keep every assertion in the *.test.ts files unchanged, and re-run so all 47 pass.
