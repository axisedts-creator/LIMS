APPROVE

Reviewed `git diff 977c571c7..HEAD` (3 pgTAP files + impl note) against migrations 20261116020000 and 20261116030000, LD-257, LD-263, LD-306 item 3.

- T0B-08_grants: provider_events dropped from the UPDATE=false loop only (DELETE=false loop untouched) and asserted UPDATE=true for the 3 app roles; matches 20261116020000 (ALTER POLICY provider_events__update__tenant only, no REVOKE). no_plan(), so count is fine. Comment names migration + LD-257.
- T0B-13.C16_schema: trigger list gains number_counters__patient_no_decrease (8), function list gains guard_counter_decrease. Names match migration lines 24/34 verbatim; the function has no SECURITY DEFINER (INVOKER, as the comment says). Comments present.
- T-SEC1 check 14: only the 3 RESTRICTIVE number_counters__{select,insert,update}__nonstaff_keys are excluded by exact name (migration lines 11/14/17). The PERMISSIVE tenant policy is still checked, so tenant isolation stays covered. Comment present.
- No test deleted or skipped. No policy, grant, migration or product change. Only owned paths. No PHI, no secrets. Out-of-scope failures (manifest_lines 135/308/481, C16 96/137/139) are listed for the lead in the impl note.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs: 4/4 pass. pgTAP not run in the lane (per brief); founder run per LD-263 confirms.
