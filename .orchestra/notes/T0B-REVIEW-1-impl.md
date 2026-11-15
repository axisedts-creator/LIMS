# T0B-REVIEW-1 impl (writer) — report only, LD-232
- Files: `.orchestra/cr/T0B-REVIEW-1.{1,2,3}.nonblocking.md` (1 provider_events UPDATE, 2 engagement ANY_T policies, 3 mfa_factors `__own`). No migration/policy/grant/test/code/spec change.
- 1: UPDATE is spec-intended (C6 05-SCHEMA §2.10, grant table); ON CONFLICT DO NOTHING needs no UPDATE. Proposal: ALTER POLICY to system actor + `applied_at IS NULL` (stamp once).
- 2: ANY_T is spec-intended (C16 05-SCHEMA §5.1/§5.2); settings/cs_* reads kept. Proposal: 3 RESTRICTIVE number_counters policies (no device; patient only booking_no/otp_day/linkfail keys). Open: patient can still lower own rate counter (needs trigger, founder call).
- 3: root cause `tenant_id IS NOT DISTINCT FROM` NULL in `mfa_factors__*__own` admits tenant-less row at aal1 / non-platform scope. Proposal: ALTER POLICY to `tenant_id = current tenant`; tenant-less via `__platform` / owner DEFINERs (LD-216).
- [CONV] CR files carry the 04-CR header lines plus the five LD-232 headings.
- Static only: no SQL run (no Docker); proposals unverified against a database.
