# C6-T05 dispute (writer, review round) — 3 failing tests, 47/50 pass; implementation done for all 4 review items

1. TEST HELPER WRONG — spike-assets "fixed, centred, rotated watermark is extracted on every page".
   The watermark IS on every page. With `opacity:.08` Skia paints it in a transparency group: each page's content stream
   does `/X6 Do` (p1), `/X9 Do` (p2), `/X12 Do` (p3); each Form XObject (objs 6/9/12) contains the same rotated `cm`
   (2.706 -1.5625 1.5625 2.706 …) and the same 9-glyph `Tj` (WMARKTEXT) with font /F4. `helpers/pdf-text.ts` `pdfPages`
   reads only the page `/Contents` and never follows `Do` into `/Subtype /Form` XObjects, so p1 shows "BODY-1BODY-2".
   Standard extractors (pdf.js, pdftotext) follow Form XObjects. Fix (helper only): on `/Name Do`, resolve the page's
   `/Resources /XObject` entry; if `/Subtype /Form`, inflate and extract it with the Form's own `/Resources /Font`
   (fall back to page fonts), recursively. Assertion unchanged.
2. ENVIRONMENT — devanagari "embeds Noto Sans Devanagari". Per review item 1 / 02-TRD §5.1 the pool no longer injects
   `@font-face`; fonts come from fontconfig in the image. This Windows host has no Noto Sans Devanagari installed, so
   Chromium falls back (round-trip tests still pass). Needs either the tests run in the image, or test setup that
   installs `fonts/` on the host — test/env scope, not writer's.
3. TEST RACE — pool "saturation … rejects 503". Long job holds the only context for timeoutMs (408) + context setup/close;
   the waiter arrives 50 ms later with the same timeoutMs bound. Margin = setup+close − 50 ms ≈ 0–30 ms (measured with
   logs: long released at +1082 ms, waiter deadline +1053 ms). Passes in isolation; failed in 1 of 2 full-suite runs.
   With one timeoutMs for both job and wait, the hold can never reliably exceed the wait. Options: (a) test accepts
   503 or a 408 for the waiter and keeps the "bounded, no leak" checks; (b) arbiter rules the queue wait has its own
   shorter bound — that needs a spec'd name (none in 02-TRD §5.1), so a CR.

## Debugger confirmation (C6-T05-debug)
Re-checked impl vs tests: all 3 failures are test/env; no impl defect found; impl unchanged.
- Watermark: HTML lives in spike-assets.test.ts:135; helper skips Form XObjects. Same finding as ruling (TESTS_WRONG, helper only; 02-TRD:990 / 01-PRD:138 require a correct extractor).
- Devanagari font name: 02-TRD:37,175 put fonts in the image's fontconfig; test must run in the image or install fonts/ on host.
- Saturation: 02-TRD:440 only says "503 pool saturated"; test cannot deterministically meet it with one timeoutMs. Test should accept 503|408 for the waiter (writer option a), or a CR for a separate wait bound.
