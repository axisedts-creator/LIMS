Title: CR-C7-001: reporting/index.ts reads process.env at import, so any bootstrap() of the real modules dir throws without LIMS_CORE_ENV + LIMS_REPORTING_OTP_HMAC_KEY_FILE
From chunk: C7            To owner: C6
Type: bug
Blocking? yes  (C7 API-T01 verify: 2 boot-against-real-repo tests; same 2 fail in lab/__tests__/boot.test.ts)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  `modules/reporting/index.ts:9` runs `loadReportingConfig(process.env)` at import. `autoload` (core/module.ts:197) imports every module, so
  `bootstrap({config})` fails with "config: LIMS_CORE_ENV must be one of dev|ci|staging|production" (the test passes LIMS_CORE_ENV only via
  `loadConfig(env)`, not process.env); once that is set, it then needs LIMS_REPORTING_OTP_HMAC_KEY_FILE. Second failure ("index.ts exports no manifest") is the same import error on a later boot.
Proposed change (exact): in reporting/index.ts take config from the injected core config / lazy-load it at boot (not at import), or have core pass env to module config loaders. Alternative (no C6 change): verify.cmd/vitest setup exports LIMS_CORE_ENV=ci and a >=32-byte LIMS_REPORTING_OTP_HMAC_KEY_FILE.
Backward compatible? yes
Tenant/security impact: none; fail-closed config behaviour unchanged.
Alternatives considered: editing reporting from C7 (not owned); weakening the boot test (forbidden).
Tests that will prove it: instruments + lab boot.test.ts "boot against the real repo" pass.
