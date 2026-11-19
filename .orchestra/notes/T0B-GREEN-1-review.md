APPROVE

Reviewed `git diff 952113428..HEAD` (tester 3b085973c, writer bc22af47a) against the T0B-GREEN-1 brief, LD-268, LD-273, 08-CR-REGISTER R10 item 5 / CR-C13-011.

Checked
- No policy, grant, migration, seed or contract edit (stop-list respected). Paths: db/tests/**, tests/db/** (same place as the earlier T0B-0x node wrappers), .orchestra/notes, .orchestra/cr only.
- STALE, DELETE-policy checks (6): the `tablename <> 'event_inbox'` filter keeps the original meaning for every business table, and a new assertion pins the inbox policy to exactly `event_inbox__delete__owner_only|{lims_owner}`. Stronger than before, not weaker.
- STALE, device actor (32): verified 08 line 217 (R10 item 5): `is_staff_or_system()` = `actor_type IN ('user','system','device')`, and CR-C13-011 is ACCEPT (08 line 560). 08 outranks chunk 01-PRD AC-0B-3.6a, so reclassifying is correct. The new assertions still prove something: device == system-actor row count (C15/C9 also have a separate `^n=[1-9]` check, so it is not 0 == 0), 0 rows of centre-scoped tables (C11), and the C14 / C10 device exclusions are unchanged. CR -004 escalates the least-privilege question on payments.* and anatomic.*. That is the right channel.
- HARNESS: the 17 `pg_temp.x` calls missing mode `'w'` are fixed. The C15 pair fixtures now build real parents. In C9 / C10, only out-of-chunk FKs that have no fixture parent are dropped. Each suite runs in BEGIN … ROLLBACK, so nothing persists. The FKs that surviving assertions rely on stay live: the specimen FK used by C10 line 195, the ast_results FK used by line 186, and the composite tenant FKs used by C9 line 199 and C10 line 246. `pg_temp.xr` rolls admitted writes back through a sentinel subtransaction, which is correct.
- REAL (5): the assertions are unedited (the wrapper test pins their text), and each has a CR with evidence and an exact proposed change. I re-read the CHECK NULL analysis and the generated-column / BEFORE trigger cause and both are sound.
- No PHI, no secrets, synthetic ids only. Names are copied from migrations and 08.

Notes (no change required)
- The notes say the regenerated fixtures engagement.sql / partners.sql were "left modified … not this task's work", but the tester commit includes them. They are generator output and get regenerated on every run, so this is harmless. The isolation suites that use them were not run here, so the lead should know that.
- MIN_ASSERTIONS guards only 2 of the 12 suites. The diff shows no deleted assertion in the other 10 (every removed line has a replacement of equal or greater strength).
- CR file naming is inconsistent (`T0B-GREEN-1-device-actor` vs `T0B-GREEN-1.<topic>`).
