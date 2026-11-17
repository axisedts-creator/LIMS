# T-Q4 dispute (writer) — TokenSlip kit test, test 5 only
- packages/ui/src/components/__tests__/tokenslip.test.tsx:55 `readFileSync(new URL('../TokenSlip/TokenSlip.tsx', import.meta.url))` throws `TypeError: The URL must be of scheme file` under `// @vitest-environment jsdom` (jsdom's global URL replaces Node's). Fails before any assertion; not an implementation defect.
- Fix (tester): same pattern as batch2-dates.test.tsx:21 — `import { URL as NodeURL, fileURLToPath } from 'node:url'` and `readFileSync(fileURLToPath(new NodeURL('../TokenSlip/TokenSlip.tsx', import.meta.url)), 'utf8')`.
- The source satisfies the asserted rules: no hex, no `style={{`, `@media print` with `80mm`. Other 4 TokenSlip tests pass.
