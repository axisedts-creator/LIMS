# T0D-CONTENT-1 dispute (writer, 2026-11-18 12:25 NPT) — TESTS_WRONG
- Test: apps/web/src/features/engagement/__tests__/adminpage-eng-1.static.test.ts:106 `expect(api).toMatch(/operationId: getEngagementSettings/)`.
- Defect: the regex source holds a literal BACKSPACE byte (0x08) right after `Settings` (od -c line 106: `S e t t i n g s \b / ) ;`). The regex therefore asks for
  "getEngagementSettings" followed by U+0008, which no YAML file contains. Likely a mangled `\b` word boundary. Context line, not part of 851d6df52.
- Proof: contracts/openapi/engagement.yaml:7849 has `operationId: getEngagementSettings` (bytes clean); `node -e` with the clean regex on the same file = true;
  vitest run -t "no new permission" fails in isolation with "expected '# contracts/openapi/engagement.yaml (…' to match /operationId: getEngagementSettings/".
- Fix (tester): delete the 0x08 byte on line 106 (optionally check line 107 too; it passes now). No code change can make the current assertion pass.
- Rest of run (2026-11-18): build:nav ok; content1 96/96, t-b6 104/104, t-l1 35/35, t-q4 82/82, adminpage-eng-1 80/81 (this line only), t-r2 33/33 (one flaky fail on first run, green on rerun, test file not touched by this task).
