# C6-T17 dispute (writer) — stale test assertions, 27 failures
Deps added per LD-62 (dompurify 3.4.17, jsdom 31.0.0; both confirmed via `npm view`; lock regenerated). With deps present, narrative.handlers: 27 fail / 204 pass; static + manifest pass.
All 27 fail on the same wrong assertion: stored sections are expected as `[{key, html}]` but spec requires `[{key, heading, html}]` (spec/chunks/C6-reporting-delivery/05-SCHEMA §2.12 l.175; reviewer finding #2 in C6-T17-review.md; tester already updated l.5/188/362/369 to headings).
1. `narrative.handlers.test.ts:210` (XSS_CORPUS it.each, 26 cases): `expect(stored).toBe(JSON.stringify(r.body.current_version.sections.map(s => ({key, html}))))` — stored now contains `heading`. Fix: map `{ key: s.key, heading: s.heading, html: s.html }`.
2. `narrative.handlers.test.ts:240` (1 case, "version moves 1 -> 2"): `expect(storedSections(...)).toEqual([{ key:'findings', html:'<p>F</p>' }, { key:'impression', html:'<p>I</p>' }])`. Fix: add `heading: 'Findings'` / `'Impression'` (copied from template).
No assertion weakened by the fix; both only add the spec-required field. Impl unchanged.
