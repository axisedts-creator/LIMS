TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/program/10-DESIGN-SYSTEM.md:48 sets `font.family.sans` = `"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif`. Plus Jakarta Sans is the Latin primary and Noto Sans Devanagari comes second.
- LD-140 (spec/program/10-DESIGN-SYSTEM.md:132; binding lead decision in the task brief) says token names stay and values change, with Plus Jakarta Sans and a Devanagari fallback. It outranks 04-UI-UX §1.4, which is a chunk doc.
- `packages/ui/src/components/__tests__/static-guards.test.ts:73-76` still requires the old value `Noto Sans, Noto Sans Devanagari`. The T0D-UI-R01 tests require the new value, so both cannot pass.
- What the test protects still applies: Devanagari must come straight after the Latin primary (10-DESIGN-SYSTEM.md:48 says "the order matters").

Change in the test:
- Line 73 title: "font.family.sans token lists Plus Jakarta Sans then Noto Sans Devanagari".
- Line 75: `expect(t).toMatch(/Plus Jakarta Sans["\\]*,\s*["\\]*Noto Sans Devanagari/);`
- Leave lines 63-72 (Noto woff2 bundle and OFL file) unchanged. Bundling Plus Jakarta Sans is CR-UI-R-001 and outside this task.
