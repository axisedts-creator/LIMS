# T0B-ACTIVATE-1 impl (writer)
Files: identity/handlers/confirmEmailToken.ts (tenant test: invite ok when provisioning|active, recovery still active only); identity/repository/mfa.repo.ts (INVITE_ACCEPT_SQL status IN ('pending','sent'), expiry kept). Both cite LD-299.
[CONV] membership activation still runs only after the invitation update returns a row (unchanged, tests pin it). Platform DEFINER accept path, rate limits, MFA, auth.service login gate, resolver: untouched.
tenant.service.ts readiness: read only, no fault.
Tests: verify.cmd set + all identity tests: 6003 pass, 10 fail, all in role-packs/apply-role-pack.script.test.ts and ci/ci-scripts.test.ts (package.json scripts, runbook, service-key grep) — unrelated to these files, not touched.
CR: .orchestra/cr/T0B-ACTIVATE-1.md (spec text C2 AC-E1.3/AC-A7.2/§3.7/§4.1 + nonblocking mail worker/template link shape).
Open: real Postgres run of the new SQL; worker + Supabase template (founder).
