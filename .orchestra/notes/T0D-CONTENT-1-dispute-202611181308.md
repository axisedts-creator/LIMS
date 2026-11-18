# T0D-CONTENT-1 dispute (debugger, 2026-11-18) — TESTS_WRONG
- Test: apps/web/src/features/engagement/__tests__/adminpage-eng-1.static.test.ts:106 `expect(api).toMatch(/operationId: getEngagementSettings<0x08>/)`.
- Proof: `sed -n 106p | od -c` shows a literal backspace (\b, 0x08) after `Settings`; contracts/openapi/engagement.yaml:7849 holds `operationId: getEngagementSettings` with no such byte. Likely a mangled `\b`.
- Implementation cannot satisfy it (contracts file not owned by this task; adding a 0x08 byte to the contract would be wrong). Fix (tester): remove the 0x08 byte on line 106. Same as writer dispute 202611181225.
