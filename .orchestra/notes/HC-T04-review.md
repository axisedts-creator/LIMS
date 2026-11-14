APPROVE

Scope note: `git diff 1d3d0c20..HEAD` is empty (HEAD == 1d3d0c20; HC-T04 is already in history). Reviewed the HC-T04 commits instead: `c777e6e2^..6911151c`.

Checked against 02-TRD §5 (H18–H20, common row), §11.2, 05-SCHEMA §2, 08 A17 P-22, A19 D-128/D-129/D-130, 07-SECURITY:
- Names verbatim: operationIds, `homecollection.settings.manage` (H18/H19), `homecollection.visit.read` (H20), the 8 reason sets (match the `g_cs_reasons__set__ck` CHECK), the 6 C4 seed payment codes, error codes `common.validation_failed` / `common.precondition_required` / `common.version_conflict` / `auth.unauthenticated`.
- §11.2 defaults and ranges match row by row. `second_identifier=birth_date` is rejected (CR-C17-003), `notify_patient_on_assign=true` is rejected (D-129), and non-seed payment codes are rejected (D-128).
- P-22: a GET with no row returns the defaults and does not persist anything. A PUT creates the row lazily via `INSERT … ON CONFLICT (tenant_id) DO NOTHING`, re-reads the row after losing the race, and the version is checked before and after the create.
- Authorisation: `assertRole` runs before any validation, and `settings.manage` is privileged (aal2 is enforced by IdentityPort). Every query filters on `tenant_id` and binds its parameters. Reasons come from the global seeds only, with `is_active` filtered.
- Logging: no PHI, no logging of the request body, no secrets. Paths are all inside the C17 module and `tests/homecollection/`.
- Tests cover done_when and the ACs: lazy create, the create race, defaults, ranges and boundaries, D-128, D-129, D-130, tenant isolation, privilege, SQL probe and no-log.

Not a code defect, but must be closed before merge: the DB suites (settings/reasons) have never run. The verify log only shows that the Docker daemon is unavailable (HC-T04-debug.md rounds 1–3). Rerun `.orchestra/notes/HC-T04-verify.cmd` with Docker up.
