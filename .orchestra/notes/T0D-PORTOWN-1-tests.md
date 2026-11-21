# T0D-PORTOWN-1 tests (LD-305, CR-C0-0B-ADMINFIX-1)
- File: services/api/src/core/ports/__tests__/registry.test.ts. New describe "owner reads its own port (T0D-PORTOWN-1, LD-305)".
- Run: .orchestra/notes/T0D-PORTOWN-1-verify.cmd (pnpm --dir services/api exec vitest run src/core/ports/__tests__: registry, authz-guard, phase-stubs).
- Now: 18 new cases FAIL (LimsError common.internal on staging/dev/ci, port_consumer_not_listed logged in production); 142 others pass. Right reason.
- Changed existing case: "no implicit owner access: billing owns BillingCommandPort ... read throws" REPLACED, it asserts the behaviour LD-305 reverses. Now "a listed consumer is unchanged"; the owner case lives in the new block. Non-owner/non-listed throw (dev/ci/staging) and production log+metric are kept and re-asserted on BillingCommandPort.
- Pins: owner reads in all 4 envs with no log and no metric; owner of two ports; missing consumers key; exact set (13 ports x 11 modules, staging: only the owner gains); owning one port grants nothing on another; fake-resolved owned port.
- Not touched: audit.chain PORT_CONSUMERS pin test; no assertRole involved.
- DONE_WHEN (5): non-test reads of ctx.ports of an owned port: ONLY identity -> IdentityPort (modules/identity/index.ts, service/audit-export.service.ts). billing, reporting, catalog, frontdesk, lab, smartreport, quality, engagement, payments: none outside __tests__. Check identity audit view + audit export on staging; no other module hit by the same fault.
