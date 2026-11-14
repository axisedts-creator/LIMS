# MET-T06 impl (writer)
- Files: `docs/manual/instruments/getein-metis-commissioning.md` (new). No tests or spec touched.
- Nine `## Step N` headings in addendum §9 order; U1..U15 each a `____` blank in the step the addendum assigns; vendor engineer vs lab staff named per step; step 4 says list is read from the analyser itself.
- [CONV] Layout and wording follow `truth-h80e-commissioning.md` (Who line, Observed/Record blanks, LD-163 cited in the source line).
- Tests: `node --test tests/docs/MET-T06.commissioning.test.mjs` = 40 pass, 0 fail.
- Open: needs a human read-through for wording; U4 time example (2026/11/14 09:30:00) is synthetic, shape taken from addendum U4.
