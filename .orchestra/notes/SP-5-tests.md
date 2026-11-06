# SP-5 tests
- File: tests/spikes/SP-5.decision.test.mjs (node:test, no deps; same layout as SP-1/2/3)
- Run: `node --test tests/spikes/SP-5.decision.test.mjs`
- Checks db/meta/decisions/SP-5.md: Decision atlas|sqitch, not supabase CLI, exact x.y.z pin with version output, Atlas-before-sqitch, criteria (a)-(g) each with a pass verdict (CONCURRENTLY file, SET ROLE lims_owner, migrations_meta/lims_migrator, checksum tamper, lock/statement timeouts, offline sandbox + telemetry switch, licence vs CV §15.2), Atlas lint Pro gap, empty-DB apply, T0A-09/T0B-01/02 hand-off, no secrets.
- Conditional: atlas -> no `atlas login`, update check off, sqitch fallback; sqitch -> Atlas rejection reason.
- Expected now: all 25 fail (verified by run) with "db/meta/decisions/SP-5.md must exist".
- Live runner behaviour (sandboxed apply, telemetry) not unit-testable; record checked structurally only.
