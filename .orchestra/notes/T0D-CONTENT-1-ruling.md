TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- apps/web/src/features/engagement/__tests__/adminpage-eng-1.static.test.ts:106 and :107 contain a raw byte 0x08 (backspace) after `getEngagementSettings` / `updateEngagementSettings` (confirmed by grep for \x08: both lines match). It is a mangled `\b`, so the regex can never match.
- The spec names the operationIds without any such byte: spec/chunks/C16-patient-engagement/02-TRD.md:524 (`getEngagementSettings`, GET /settings) and :525 (`updateEngagementSettings`, PUT /settings).
- The contract is correct: contracts/openapi/engagement.yaml:7849 `operationId: getEngagementSettings`, :7925 `operationId: updateEngagementSettings`.
- Binding lead decision LD-377 (2026-11-18 13:08 NPT) gives the same ruling, TESTS_WRONG.
- TESTER, change exactly this: line 106 `expect(api).toMatch(/operationId: getEngagementSettings(?![A-Za-z0-9_])/);` and line 107 `expect(api).toMatch(/operationId: updateEngagementSettings(?![A-Za-z0-9_])/);`. Do not use `\b` or any other backslash-letter escape in regexes written through a shell or heredoc.
- After the edit, check that every touched test file has 0 bytes of 0x08.
- WRITER/DEBUGGER: implementation accepted; no code or contract change. Re-run the engagement web tests after the tester pass.
