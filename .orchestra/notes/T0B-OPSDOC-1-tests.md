# T0B-OPSDOC-1 tests (tester)
- NEW tests/docs/lims-env-scan.mjs: the scan (api+worker+web src; comments, tests, fixtures skipped); exports scanLimsEnv(root); CLI prints names. Writer reuses it to build the doc.
- NEW services/api/src/__tests__/env-doc.test.ts: scan on a fixture tree; doc lists every scanned name once in table `| Name | Module | Required | When unset |` (required|optional); detector fails on a missing name; no values/URLs/keys in doc.
- NEW services/api/src/core/__tests__/health-env.test.ts: /ready degraded + `missing_env` (sorted names, only when non-empty); 503 still lists them; no values; optional never degrades.
- Run: `.orchestra/notes/T0B-OPSDOC-1-verify.cmd`. Both fail now: docs/runbooks/environment.md is missing.
- ASSUMED INTERFACE (not in spec; writer follows): bootstrap option `env` replaces process.env for the check; "required" = rows marked required in the doc; unset = missing or empty.
- CONTRACT GAP: core.yaml Readiness is closed (additionalProperties:false), so names need an optional `missing_env` there (contracts/openapi is not in the brief's file list): lead rules or CR. A static test pins it.
- RISK: existing health.test.ts expects the exact ok body under default process.env; required names must be set by src/__tests__/setup-env.ts (test file, writer cannot edit) or the route must scope by env. Lead decides.
- Not tested: render.yaml unchanged (done_when 4), a real deployed env, names built at run time.
