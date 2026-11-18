Title: CR-C0-T0B-GREEN-1-001: three smartreport CHECK constraints accept NULL (three-valued logic) where the contract requires a value
From chunk: C0 (lane C0-0B, T0B-GREEN-1, suite db/tests/smartreport/T0B-13.C14_behaviour.test.sql)            To owner: C0-0B (lead triage; schema owner C14)
Type: bug
Blocking? no (LD-268: a REAL defect is not fixed in T0B-GREEN-1; the three assertions stay red, unedited)
Problem: the CHECKs evaluate to NULL, not FALSE, for the rows below, and PostgreSQL treats NULL as pass.
  - rules__followup_fields__ck (20261115140000_smartreport__create_smartreport_schema.sql:215): a `followup` rule with `interval_days` NULL gives (TRUE AND TRUE AND NULL) OR (FALSE ...) = NULL, so it is accepted. Test 357 "a follow-up rule without interval_days fails (no default)" gets n=1 instead of E23514.
  - library_versions__hash__ck (:134): status <> 'draft' with `content_sha256` NULL gives FALSE OR (NULL ~ regex) = NULL, so a library can leave draft without a hash. Test 370 gets E23505 (library_versions__tenant_id__open__p_uq, reached only because the CHECK passed) instead of E23514.
  - summaries__score__ck (:382): `health_score_value` = 50 with `health_score_band` NULL gives FALSE OR (TRUE AND NULL) = NULL, so a score without a band is accepted. Test 373 gets n=1 instead of E23514.
  Evidence: db/tests/run-suites.sh run of the 12 C9..C15 suites on the pinned image, T0B-GREEN-1 (not ok 357, 370, 373 of T0B-13.C14_behaviour). The fixtures are valid: library 3002 is a draft without a hash, rule 3201 is a follow-up with interval 90, summary 3704 is a draft.
Proposed change (exact): a new migration (never an edit of 20261115140000) replacing the three constraints with NULL-safe forms, e.g.
  rules__followup_fields__ck: (rule_kind = 'followup' AND suggested_test_id IS NOT NULL AND interval_days IS NOT NULL AND interval_days BETWEEN 1 AND 730) OR (rule_kind <> 'followup' AND suggested_test_id IS NULL AND interval_days IS NULL)
  library_versions__hash__ck: status = 'draft' OR (content_sha256 IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$')
  summaries__score__ck: (health_score_value IS NULL AND health_score_band IS NULL) OR (health_score_value IS NOT NULL AND health_score_band IS NOT NULL AND health_score_value BETWEEN 0 AND 100 AND health_score_band IN ('good','fair','needs_attention'))
  The lead should also check the other smartreport CHECKs (and the CHECKs of C9..C15) for the same `col BETWEEN` / `col ~` / `col IN` without IS NOT NULL.
Backward compatible? yes for valid data; rows that already break the rule (none can exist in the test image) would block the migration.
Tenant/security impact: none (integrity of clinical summary data only); no RLS change.
IRD/regulatory impact: none
Alternatives considered: editing the three assertions to the current behaviour (refused: LD-268, it would hide the defect).
Tests that will prove it: db/tests/smartreport/T0B-13.C14_behaviour.test.sql assertions 357, 370, 373 (already written; green once the migration lands).
