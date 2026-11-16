# T0D-MSERIES-3 dispute (writer)
Test: `mseries3_test.dart` "each Poppins asset exists, is a TrueType/OpenType file ... and is not a stub", assertion `b.length > 20000`.
Why wrong: the only pinned Poppins source is @fontsource/poppins 5.3.0 (same pin as packages/ui, LD-251). Its latin woff unwrapped
losslessly by the existing `tool/woff2ttf.py` gives real TTFs of 15.8-16.1 KB (magic 00 01 00 00, all tables intact; the Plus
Jakarta latin TTFs were ~29.7 KB, Noto Sans ~28 KB). 20000 is a size guess, not a stub check. Merging latin + latin-ext needs
fontTools (not installed, would be a new tool dependency) or a hand-written glyph merger; fetching full TTFs from GitHub would be an
unpinned source.
Proposed fix: lower the bound to e.g. `> 10000` (still rejects stubs; woff2/stub magic check stays). Everything else is implemented;
with that change the verify run is fully green (currently 1 failure = this assertion).
