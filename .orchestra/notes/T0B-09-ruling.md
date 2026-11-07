TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Change: tests/db/T0B-09.seeds.test.mjs:71 must stop asserting `SET LOCAL ROLE lims_owner` for every seed. Replace with a per-file rule:
- seeds 001–003 (class G, `/^00[1-3]_/`): assert `/SET\s+LOCAL\s+ROLE\s+lims_owner/i`.
- seeds 010+ (tenant-scoped, `/^(0[1-9]\d|[1-9]\d\d)_/`): assert `/SET\s+LOCAL\s+ROLE\s+lims_app/i` AND that it appears after a `set_config('request.jwt.claims', …, true)` call; assert they do NOT `SET LOCAL ROLE lims_owner`.
Rename the `it` title to "every seed is idempotent, role-scoped (001-003 lims_owner, 010+ lims_app) and destructive-free". Leave lines 72-76 unchanged.
Reasons:
1. Test's basis is spec/chunks/C0-foundation-contracts/02-TRD.md:307 ("run as lims_migrator → SET LOCAL ROLE lims_owner").
2. LD-30 (2026-11-07, binding, overrides spec text for T0B-09; .orchestra/inbox/T0B-09-arbiter.md:29) accepts CR-C0-T0B-09 (.orchestra/cr/T0B-09.resolved-202611071058.md): 010+ run `SET LOCAL ROLE lims_app` after setting claims; 001-003 keep lims_owner.
3. 02-TRD.md:307 intent ("so RLS WITH CHECK applies even to seeds") is preserved by lims_app + real `<table>__insert__tenant` policy; no owner-bypass policy added (LD-30).
4. Writer then applies LD-30 to db/bootstrap/00_roles.sql (`GRANT lims_app TO lims_migrator WITH INHERIT FALSE, SET TRUE;`) and db/tools/gen-seeds.ts. The 001 failure (missing SET LOCAL ROLE) stays a valid test failure, blocked on .orchestra/cr/T0B-09-001-generator.md.
