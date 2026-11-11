TESTS_WRONG — web-t04.components.test.tsx L166 picks an ambiguous row, and L296 requires the BFF's request to C3 to have no JWT. The spec requires the opposite.
Reasons:
- spec/chunks/C7-instrument-integration/04-UI-UX.md:148: the Mappings table MUST show "Instrument code". The test file itself finds the GLU map row by code (L183). With manage + MAPROWS (map M2 = GLU) + observed GLU, two rows match /\bGLU\b/, so `getByRole` at L166 must throw. The spec cannot be met while that test passes.
- 04-UI-UX.md:147: status shown = E32 "Mapping status" text in the Observed codes panel. The assertion's intent is valid. Only its scope is wrong.
- spec/program/02-CONVENTIONS.md:231 (REQ-SEC-068): the browser talks only to the BFF, and the BFF talks to the API. The file header (L6) says server actions run for real against MSW, so the recorded request is BFF→C3 and must carry the JWT (server test L159 asserts `Bearer jwt-synthetic` on the same call). No spec line requires that request to have no Authorization header.
- The browser-side rule (no JWT in component code) is already covered by the static guard at web-t04.server.test.ts L461.
Change the tests:
1. L166: scope the lookup to the observed panel, e.g. `within(<Observed codes region/table>).getByRole('row', { name: /\bGLU\b/ })`. Keep the manager view and keep the `Unmapped` assertion (the map exists in C3 but E32 still says unmapped).
2. L296: delete the line. Optionally replace it with `expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic')`.
