APPROVE

Re-review after `bfb0c03` ([writer] T0B-06 review fixes). Both earlier CHANGES items are resolved through CR `.orchestra/cr/T0B-06.md`:
1. `app.identity_is_breached(bytea)` (C2 05-SCHEMA §10.3 L1688–1692, L1714–1715) moves to the C2 identity migration. The proposed change is exact: verbatim body plus REVOKE PUBLIC and GRANT lims_app.
2. The done_when item "owner policies of C2 §5.4/§10.1 (incl. `platform_staff__select__owner_only`)" moves to the C2 row that creates `identity.*`. The CR records that C2 §11 tests 21–22 are covered here only through `db/tests/fixtures/T0B-06_identity_standin.sql`.

SQL is unchanged since the last review. The 19 DEFINER bodies, grants and `core.membership_branches` (ENABLE+FORCE RLS, `__tenant` policies, `__scope_user_only` triggers) still match the spec. Every pre_*/maintenance GUC is reset to '' before return. No secrets, no PHI and only owned paths. `node --test tests/db/*.test.mjs` = 67/67 pass.

Not blocking: pgTAP suites have still never run (no psql/pg_prove on this host). They need a first-run shakeout before T0B-08 CI relies on them. The CR needs an orchestrator-assigned CR-C0-<nnn> number.
