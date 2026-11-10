## J-T01 tests — BLOCKED on FD-T06
- File: services/api/src/modules/frontdesk/__tests__/integration/registration.billing-real.gate.test.ts (gate only).
- Run: `.orchestra\notes\J-T01-verify.cmd` (pnpm --dir services/api exec vitest run src/modules/frontdesk/__tests__/integration).
- Gate fails now for the right reason: frontdesk/service/registration.service.ts (FD-T06) does not exist in this tree; BL-T07 impl exists.
- Not written: the real rollback test (US-FD-03.5: fail after issueOrderInvoice -> counter rolled back, next invoice reuses number) and the FD suite swap.
  Writing them would mean inventing createRegistration's signature, FD tables and the test harness. Not done on purpose.
- Needed: land FD-T04..T06, then re-run TESTER for J-T01. Do not re-route to the debugger (no impl defect).
