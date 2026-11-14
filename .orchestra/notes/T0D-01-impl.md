# T0D-01 impl (writer) — LD-53 reopen
- Files: services/api/src/core/module.ts (bundleRefs.place alias), src/core/openapi.ts (AJV keywords), services/api/vitest.config.ts (new, setupFiles -> src/__tests__/setup-env.ts; LD-53 (2)).
- LD-53 (1): local node exactly `{ $ref: <same file>#<same pointer> }` is replaced by the cloned target; place() runs before the $ref rewrite so the original string is checked. Siblings / other file / different def still throw.
- [CONV] `discriminator` registered as annotation keyword (like x-coded-set): ajv `discriminator: true` throws "mapping is not supported" and 02-CONVENTIONS requires explicit mapping; `oneOf` still validates. No strictSchema change.
- Ran: T0D-01 verify set + lab/instruments/catalog boot: 294/295 pass. Full suite --maxWorkers=4: 4405 pass / 3 fail; default workers: random timeouts under load (lab/catalog/core boot pass alone).
- Open (non-blocking, other owner): instruments boot `POST /v1/instruments/agent/enrolments` `{}` -> 400 not 401: glue security runs as preHandler, after body validation (T0D-02 auth ordering).
- Open: `tsc --noEmit` fails in packages/shared-ts/src/bsdate/index.ts (TS5097 `.ts` import), pre-existing, not owned.
