# BL-T04 impl (writer)
Files: services/api/src/modules/billing/service/counter.service.ts (new; only owned path). Reuses config.ts counterLockTimeoutMs and domain/fiscalYear.ts checkFiscalYear.
Own UPDATE … RETURNING last_no, clock_timestamp() (repo bumpCounter lacks allocated_at); counters.repo.ts untouched.
[CONV] 55P03 from the counter UPDATE or the row-create INSERT → counter_busy (retryAfterSeconds 1); other 55P03/40P01 propagate raw. Lock timeout set via bound `$1ms`, reset to '0' right after the last counter statement.
[CONV] UPDATE also requires `is_active` (as counters.repo.ts); INV:<branch> without {branch} token or without pattern → numbering_pattern_invalid before any SQL; validation mirrors the DDL CHECKs.
Result: 47 pass, 7 live skipped (no DB), 1 FAIL → disputed, see BL-T04-dispute.md (SimDb row-visibility model gap). Live DB run not done.
