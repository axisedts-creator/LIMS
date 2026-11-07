# T0C-07 impl
- Files: `packages/fakes/src/{base,event-spy,harness}.ts`, 13 × `src/<Port>.fake.ts`, `src/stubs/{Quality,SmartReport,PaymentProvider,Engagement}Port.stub.ts`, 13 × `contract-tests/<Port>.contract.ts`, `contract-tests/formula.vectors.json`; package.json (vitest 3.2.4, `test`, `@lims/contracts`).
- Result: `npx vitest run __tests__/` → 4 files, 458 passed, 37 skipped (non-phase1Stub cases on the stub runs), 0 failed.
- [CONV] harness `ctxFor` key grammar `A|B[:actorType[:persona]]`, fresh tx per ctx; `h.rollback(tx)`; fixture rows upserted by `id`, else first non-tenant `*Id`, else `tenantId`.
- [CONV] fake-only values: Payment TTL 900 s/grace 600 s/Khalti min 1000 paisa; synthetic FY start; Identity setting defaults; Notification staff contact from `staffContacts` fixture; Lab cross-tenant barcode → `lab.specimen_not_found`; G6/G7/G8 unspecified inputs synthetic.
- Fakes expose test-only `__*` hooks (Frontdesk `__deliver`/`__orderFlags`, Billing `__ledgerRows`/`__reviewItems`); real-impl harnesses must supply equivalents.
- Open: IdentityPort fake imports `contracts/ports/generated/permissions.ts` by relative path (subpath not exported by `@lims/contracts`); `packages/fakes` has no tsconfig/typecheck script — ad-hoc `tsc` shows 164 errors (mostly implicit any, unexported subpaths).
- Open: Notification provider-failure simulation and Lab device→centre restriction not built (no IC case uses them); BillingCommand (15) "counter unchanged" asserted loosely.
