APPROVE
Range ed94610..HEAD (664e840, 0ba3afe, bb6b418): fixture-only change per LD-36.
- db/tests/core/T0B-05_platform.test.sql:134-135 `platform_admin` -> `platform_superadmin`: matches C2 05-SCHEMA:174 role set and the CHECK at 20261105001300_identity__create_identity_schema.sql:59; dl_* gate `platform.dead_letter.manage` = [platform_superadmin] (03:3003). No other test weakened.
- LD-31 state at HEAD verified: package.json `"graphile-worker": "0.18.0"`; T0-03-dependencies.md row (MIT); run-suites.sh SP-2 step (b) before 20261105001200 with REVOKE + exit 1 on failure; fallback gone from 20261105001200 (only comment remains).
- Reviewer re-ran `bash db/tests/run-suites.sh --no-seeds db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql`: "Schema updated", 0 `not ok`, 0 `# Failed`, no psql ERROR.
- No PHI, no secrets, only owned paths (test + notes).
Open (not a defect of this range): full run with seeds still blocked by seed 010 RLS (T0B-09); `--no-seeds` must stay local-only.
