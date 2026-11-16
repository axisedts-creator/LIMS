# VERIFY-GREEN-3 impl (writer)
- Files: frontdesk `registration.service.ts` (portCtx returns RequestContext; `asRc` type view at 6 raw-ctx port calls; `orderableIds ... as never`), `order.service.ts` (portCtx return type RequestContext), billing `BillingPort.impl.ts` + `BillingCommandPort.impl.ts` (`as unknown as` on 6 port casts; `orderId as OrderBalance['orderId']`), `invoice.service.ts` (`issuedAt: allocatedAt as IsoUtc`, same cast as line 245).
- [CONV] types only. Money/order code: no emitted value, rounding, status or SQL changed; `asRc`/portCtx return the same objects. No ts-ignore/`as any`/skipLibCheck added.
- Errors in the 5 files: 29 -> 0. `turbo run typecheck --continue` after: @lims/api 9 (2 shared-ts TS5097 owned by C0 per ruling, 7 quality), @lims/web 294, @lims/worker 10; none in the 5 files. Per-package before counts not saved by tester (api 29 in these files).
- Tests: VERIFY-GREEN-3-verify.cmd (frontdesk ci + billing contract) 9 files, 171/171 pass after ruling fix.
- Not run: frontdesk DB tests (need LIMS_TEST_APP_URL/docker, FD-T03-verify.cmd); Ctx edits proven by tsc + type-only diff.
- Open: handler ctx `now()` Date vs IsoUtc at raw-ctx port calls; readers checked, no wrong value today; see notes/VERIFY-GREEN-3.md (no CR needed).
