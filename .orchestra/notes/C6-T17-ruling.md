TESTS_WRONG — the stored-section assertions omit `heading`, which the spec requires in every stored narrative_versions section.
Reasons:
1. spec/chunks/C6-reporting-delivery/05-SCHEMA.md:175 — `narrative_versions.sections jsonb N (array ≤ 12 of {key, heading, html}; …)`. A stored section without `heading` breaks the schema, so the impl is right to store it.
2. spec/chunks/C6-reporting-delivery/05-SCHEMA.md:180 — `narrative_templates.sections` carry `heading ≤ 80`; that is where the stored heading comes from (test header l.5 already says "heading copied from the template").
3. The test file is inconsistent with itself: l.5 and l.165 already expect headings, but l.210 and l.240 still expect `{key, html}`.
Changes to the test (nothing else changes; no assertion gets weaker):
- narrative.handlers.test.ts:210 — map to `({ key: s.key, heading: s.heading, html: s.html })` so the "what is shown is what is stored" equality still holds in full.
- narrative.handlers.test.ts:240 — expect `[{ key: 'findings', heading: 'Findings', html: '<p>F</p>' }, { key: 'impression', heading: 'Impression', html: '<p>I</p>' }]`, using the headings from the fixture template.
- Keep the key order key, heading, html at l.210, because that assertion compares JSON strings (order matters). The impl must store keys in that order, or the test must compare parsed objects with toEqual.
