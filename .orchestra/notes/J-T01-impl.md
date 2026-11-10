## J-T01 impl (supersedes earlier BLOCKED note; FD-T06 + BL-T07 now merged)
- Changed: `frontdesk/service/registration.service.ts` quote() only — `assertCreditAllowed` now gets `additional: q.totals.net` (full Money incl. currency 'NPR'), same as register() line ~308. [CONV] port input Money; real billing rejects missing currency.
- Verify: `tests/frontdesk/J-T01.pg.sh` (docker PG17) = 2 files / 26 tests pass (was 24/2 fail; both fails were US-FD-04.1 credit quote).
- pending.json (LD-70): `frontdesk/__tests__/probes/` absent, nothing to remove.
- Not run green: other FD DB suites (quote/registration/rollback) need LIMS_TEST_APP_URL (FD-T03 verify.cmd); not re-run here. tsc has pre-existing errors in contracts/ + shared-ts, none in registration.service.ts.
- No test dispute.
