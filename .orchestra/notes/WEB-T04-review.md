APPROVE
Scope: b9c23199..HEAD (72532200 tester, d3b478ed writer, 00f7957a arbiter).
- web-t04.components.test.tsx L166: lookup now scoped to the "Observed codes" table (caption exists, InstrumentMappings.tsx:124); `Unmapped` assertion kept — matches ruling item 1 (04-UI-UX.md:147-148).
- L298: asserts `Bearer jwt-synthetic` on the recorded BFF→C3 request — matches ruling item 2 (REQ-SEC-068); browser-side no-JWT rule still covered by static guard in web-t04.server.test.ts.
- No impl change in range; writer only updated notes. No new names, no PHI/secrets, only owned/permitted paths.
- Verify: `.orchestra/notes/WEB-T04-verify.cmd` (vitest.web-t04.config.ts) → 2 files, 188/188 passed.
