TESTS_WRONG — t20.fix10-resend-invitation.test.tsx:138 asserts the literal text "Error:" is absent; the spec only forbids stack traces/SQL/file paths, and the kit Banner's "Error: " tone label is spec-required.
Change line 138 to match stack-trace shapes only, e.g. `expect(pageText()).not.toMatch(/\bat \w+ \(|\.[jt]sx?:\d+|stack/i);` (drop the bare `Error:` alternative). Keep lines 136–137 (REF shown, never "Invitation sent.") unchanged.
Reasons:
1. spec/research/02-security.md:175 (REQ-SEC-095) forbids stack traces, SQL, file paths in error output — not the word "Error".
2. spec/chunks/C0-foundation-contracts/01-PRD.md:203 (AC-0D-3.1): "no stack trace, SQL or file path" — same scope.
3. spec/chunks/C0-foundation-contracts/03-APP-FLOW.md:276: error surface shows "Reference: …", "never stack traces" — the impl shows the reference (test line 136 passes).
4. spec/chunks/C0-foundation-contracts/04-UI-UX.md:336: "Colour is never the only signal" — the kit Banner's VisuallyHidden tone text (packages/ui/src/components/Banner/Banner.tsx:23, messages.ts:21 danger:'Error') implements this; removing it to satisfy the test would break the spec.
5. Task brief requires kit components only and the same dialog as the detail page; the impl uses the shared kit Banner via admin Alert, so it complies.
