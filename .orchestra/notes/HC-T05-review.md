APPROVE

Re-review of `5f65c751..HEAD` (commits 8fea0227 tests and 5c35b896 writer), checked against the CHANGES items from the previous review (a09a61d4).

1. Access log, fixed. visit.service.ts:76–82 now generates `visitId` before the port call and reuses it in `insertVisit`. After every port call, on both the success and the catch path, it writes `ctx.audit.access({action:'home_visit.view', entityType:'home_visit', entityId: visitId, purpose:'home_address_fetch', outcome:'allowed'})`. That matches 02-TRD §8.2 and the §14 table row at 02-TRD:625. No row is written on redelivery or when there is no `home_address_id`, and `centre_visit` returns early. `outcome:'allowed'` follows the platform `audit.access` type (worker send_portal_otp.ts:77).
2. Access-log tests, fixed. The `audit` stub is replaced by a recording fake. The test asserts exactly one row with the visit id for US-01-4 success and for port-throws. It asserts zero rows for no-address, redelivery and centre_visit (US-01-3).
3. done_when, fixed. `vi.setConfig({testTimeout:30_000, hookTimeout:60_000})` is set. I reran tests/homecollection/HC-T05.pg.sh myself on live PG17: 35/35 passed in 29.66s, which agrees with the writer's log.

The other checks still pass: names are verbatim, tenant guard in place, no PHI in logs (the sentinel assertion still holds), no secrets, only owned paths touched.
