Title: CR-C4-FD-T01: modules/reporting throws at import, so no other module's boot test can autoload the real modules dir
From chunk: C4            To owner: C6 (cc C0-0D: bootstrap has no module-init hook today)
Type: bug
Blocking? yes — C4 FD-T01 done_when "Core boots with module" (boot.test.ts autoload + 3 bootstrap cases red)
Problem: services/api/src/modules/reporting/index.ts:8 runs `loadReportingConfig(process.env)` at import.
FD-T01 boot tests autoload the real modules dir via `bootstrap(loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_* }))`
(per FD-T01 ruling) and leave process.env unset. Result: `config: LIMS_CORE_ENV must be one of dev|ci|staging|production`
(reporting/config.ts:46), then `module reporting: index.ts exports no manifest`. Frontdesk manifest itself validates.
Any chunk's real-bootstrap test is broken by this, not only C4.
Proposed change (exact): reporting validates its config from the env/config the bootstrap passes in, not from
process.env at import. Either (a) C0-0D adds an optional `init(env)` to ModuleManifest called by bootstrap (boot still
fails on bad LIMS_REPORTING_*, 02-TRD §10.1 kept), and reporting moves loadReportingConfig there; or (b) C6 picks
another approach that does not throw at import when process.env lacks LIMS_REPORTING_*.
Backward compatible? yes (additive optional hook; reporting behaviour on bad config unchanged: boot fails).
Tenant/security impact: none; must NOT weaken REQ-SEC-128 / REQ-SEC-136 (no defaults for the HMAC key, no fail-open).
Alternatives considered: C4 sets process.env / skips reporting in its tests — rejected (tests are not C4-writer owned;
ruling says keep real bootstrap with real repo root).
Tests that will prove it: `.orchestra/notes/FD-T01-verify.cmd` → vitest 30/30, node:test 9/9.
