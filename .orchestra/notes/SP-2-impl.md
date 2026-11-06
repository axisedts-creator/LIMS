# SP-2 impl
- Files: db/meta/decisions/SP-2.md (record, outcome partial), services/worker/src/core/DECISIONS.md (residual privilege), .orchestra/cr/SP-2.nonblocking.md (CR to CV §5.9, 07-SECURITY §6, 05-SCHEMA §10).
- Live spike run: throwaway postgres:17 + graphile-worker@0.18.0, roles per 05-SCHEMA §1; container + scratch removed.
- Partial because worker needs inherited lims_queue owner rights (graphile_worker _private_* tables: RLS on, 0 policies; DML-only role tested, fails).
- [CONV] dead-letter wrapper detects permanent failure via helpers.job.attempts >= max_attempts (events not awaited).
- Finding: text crontab rejects '.' in task ids, so T0D-09 must use parsedCronItems/parseCronItems.
- Open: D-201 window must be 3 steps (install on separate connection); permafailed-job cleanup owner; re-check on supabase/postgres:17.6.1.136 + PgBouncer.
- Tests: node --test db/tests/spikes/SP-2.decision.test.mjs 15/15 pass; SP-1 8/8 pass. Open: old unowned tests/spikes/SP-2.decision.test.mjs still present; tester must git rm it (writer may not touch tests).
