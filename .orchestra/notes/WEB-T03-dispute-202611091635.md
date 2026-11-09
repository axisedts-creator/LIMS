# WEB-T03 dispute (writer, round 2)
1. web-t03.components.test.tsx:114 — `^Vendor$` columnheader. C7 04-UI-UX.md:122 names the column "Vendor/Model" (header shown "Vendor / Model"), so an exact `^Vendor$` cannot match without breaking the spec. The anchoring (ruling item 1) was only meant for "State"/"Link state". Fix: `/^Vendor/i` for that header (or anchor only 'State').
All other 97 tests pass (vitest.web-t03 config). Writer stops on this item.
