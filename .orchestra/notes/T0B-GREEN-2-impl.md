# T0B-GREEN-2 impl (writer)
- Files changed: none outside this note. Tester commit 6780ffa8e holds every allowed fix (21 STALE, 29 HARNESS + 3 psql aborts, all in db/tests/**); REAL 0 left red, so no product edit is due.
- [CONV] Stop-list respected (LD-268): no policy, grant, migration, seed or contract edit. The D-136 lims_migration grant stays a CR (CR-C0-T0B-GREEN-2-001), applied only inside the rolled-back test transaction.
- Run 2026-11-18: `node --test tests/db/T0B-GREEN-2.pgtap.test.mjs` passed 3 of 3, 0 failed (run-suites.sh over 23 suites, 110 s; no psql abort; no not ok; only SKIP is the storage bucket probe, LD-54).
- Open: CR-C0-T0B-GREEN-2-001 (D-136), CR-C0-T0B-GREEN-1-004 (device actor). Immutability suite: collector_flags, partner_ticket and 4 sales tables lack __mutable_columns trigger (other task). No dispute filed.
