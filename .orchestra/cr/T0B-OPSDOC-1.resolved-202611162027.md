```
Title: CR-C0-T0B-OPSDOC-1-001: add optional `missing_env` to the Readiness schema in contracts/openapi/core.yaml
From chunk: C0 (C0-0B)     To owner: C0-0C
Type: api
Blocking? yes — C0 06-IMPLEMENTATION-PLAN T0B-OPSDOC-1 done_when (3) (LD-277, audit RS-16): /ready must report degraded
  with the NAMES of required LIMS_* variables that are unset. Readiness is closed (additionalProperties: false), so the
  response validator rejects the new field (500) until the schema has it. services/api/src/core/__tests__/health-env.test.ts
  pins the field and fails without it.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  A person setting up a new environment cannot see from the health route which required variables are unset.
  contracts/ is C0-0C ONLY (spec/program/01-CHUNK-MAP.md:108); the C0-0B lane may not edit core.yaml.
Proposed change (exact), under components.schemas.Readiness.properties (NOT added to `required`):
        missing_env:
          description: T0B-OPSDOC-1 (LD-277). Names of required LIMS_* variables that are unset; names only, never values. Present only when non-empty.
          type: array
          items: { type: string, pattern: '^LIMS_[A-Z0-9_]*[A-Z0-9]$' }
Backward compatible? yes — new optional response field; existing bodies without it still validate. `status` already allows `degraded`.
Tenant/security impact: no RLS change, no PHI field, no new route. Public /ready gains variable NAMES only (never values);
  the pattern forbids anything but a LIMS_* name. Names are already public in docs/runbooks/environment.md.
IRD/regulatory impact (billing changes only): none.
Alternatives considered:
  A. Put the names inside `checks` — also closed, same CR needed; mixes dependency state with config.
  B. Log names only, no body field — fails done_when (3).
Tests that will prove it:
  - pnpm --dir services/api exec vitest run src/core/__tests__/health-env.test.ts src/core/__tests__/health.test.ts src/__tests__/env-doc.test.ts
```
