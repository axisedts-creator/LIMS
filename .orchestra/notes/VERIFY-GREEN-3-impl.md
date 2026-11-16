# VERIFY-GREEN-3 impl (writer)
- Files: frontdesk `registration.service.ts` (portCtx returns RequestContext; `asRc` type view at 6 raw-ctx port calls; `orderableIds ... as never`), `order.service.ts` (portCtx return type RequestContext), billing `BillingPort.impl.ts` + `BillingCommandPort.impl.ts` (`as unknown as` on 6 port casts; `orderId as OrderBalance['orderId']`), `invoice.service.ts` (`issuedAt: allocatedAt as IsoUtc`, same cast as line 245).
- [CONV] types only: no value, SQL, rounding or status changed; `asRc` returns the same object. No ts-ignore/`as any` added.
- tsc (services/api): errors in the 5 files 29 -> 0; api total now 9 (2 shared-ts TS5097 + quality/other, all outside this task). turbo per-package counts not run.
- Tests: billing contract suites + vg3 no-hiding test pass (170/171). vg3 test 1 FAILS only on the pre-existing shared-ts TS5097 (line 26): see `VERIFY-GREEN-3-dispute.md`.
- Not run: frontdesk DB tests (need LIMS_TEST_APP_URL/docker, FD-T03-verify.cmd).
- Open: handler ctx `now()` is a Date but raw-ctx catalog/billing calls (registration.service quote path) type it IsoUtc; unchanged at runtime, runtime question for lead (no CR written yet).
