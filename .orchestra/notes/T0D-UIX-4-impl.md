# T0D-UIX-4 impl (writer)
- Files: 27 feature components (9d4f4332c) + RegistrationForm.tsx (08389fa4a, b68d214bb); list in T0D-UIX-4-screens.md. No CSS, tokens, route, permission or API change.
- Review fixes: screens.md and left.md added; scratch apps/web/uix4-after.txt and vitest.tmp-uix4.config.ts already absent.
- LD-443 snapshots: rs-c2 (1), rs-c4 (4), rs-c7 (2) regenerated with -u after reading the diff. Diff is markup only (table->grid roles, kit class names, react-aria ids, trailing spaces trimmed, visually hidden headers now kit headers); every text and data value is identical.
- [CONV] kit DataTable for every list incl. InstrumentsList (ruling B); DescriptionList for label/value pairs (LD-442).
- Checks: uix4.markup 9/9; rs-c2 config 74/74; rs-c7 config 34/35 (behaviour:93 green after tester fix; static:101 not this task), rs-c4 config 32/37 (reds listed in T0D-UIX-4-left.md).
- Open: items in T0D-UIX-4-left.md.
