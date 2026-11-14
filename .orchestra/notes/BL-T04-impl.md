# BL-T04 impl (writer)
Files: services/api/src/modules/billing/service/counter.service.ts (new; only owned path). Reuses config.ts counterLockTimeoutMs and domain/fiscalYear.ts checkFiscalYear.
Own UPDATE … RETURNING last_no, clock_timestamp() (repo bumpCounter lacks allocated_at); counters.repo.ts untouched.
[CONV] 55P03 from the counter UPDATE or the row-create INSERT → counter_busy (retryAfterSeconds 1); other 55P03/40P01 propagate raw. Lock timeout set via bound `$1ms`, reset to '0' right after the last counter statement.
[CONV] UPDATE also requires `is_active` (as counters.repo.ts); INV:<branch> without {branch} token or without pattern → numbering_pattern_invalid before any SQL; validation mirrors the DDL CHECKs.
Re-run after ruling (SimDb fixed, service unchanged): 48 pass, 7 live skipped (no DB), 0 fail. tsc: 0 errors in billing; 2 pre-existing errors outside owned paths (contracts/ports/IdentityPort.ts, packages/shared-ts/src/bsdate/index.ts). eslint not installed in services/api.
Open: live DB run (counter.live.test.ts) not done, needs LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL.
