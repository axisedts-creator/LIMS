APPROVE

T0C-08 review (diff 2ee0987..e8f204c), AC-0C-4.1 / AC-0C-4.2.

- Names: `pnpm mock:<m>` / `mock:list`, `prism mock contracts/openapi/<m>.yaml --host 127.0.0.1 --port <4100+index>` match 02-TRD §397 exactly. `core` is row 0 of the CM §3 module table, so port 4100 is correct. Prism 5.16.0 pinned as the TRD requires. `@lims/fakes/msw` matches the PRD.
- Paths: `packages/fakes/**` and `tools/codegen/**` are C0-0C (CM §3). Root `package.json` is C0-0A, but the task brief names it ("handed to 0A"), so it is allowed.
- Tests: re-ran `tools/codegen` `npx vitest run __tests__/mocks.test.ts` and got 14/14 passing. The tests read operations from the real contracts. They check one handler per operationId, the lowest 2xx status with the spec example, `codegen` freshness, that each domain has a script, unique ports, and that unmatched requests error.
- Tenant isolation, RLS, permissions, idempotency and rate tier are not touched by this task. No PHI, no secrets. Handler bodies are synthetic health examples, and the host is bound to loopback only.
- Not a defect (noted for 0A): Prism was never actually run, so "Prism serves examples" was not smoke-tested. The tests check only the script wiring and the pin.
