# SP-8 impl
- Files: db/meta/decisions/SP-8.md (new). Live probe ran in gitignored build/sp8-spike/ (not committed).
- Decision: as-designed — glue 4.12.0 + Fastify 5.12.8; all 12 features reachable; x-* via request.routeOptions.schema.
- [CONV] ajv customOptions removeAdditional:false, coerceTypes:'array', allErrors:true (default Fastify ajv silently strips unknown body fields — probed).
- [CONV] core onRoute sets querystring additionalProperties:false (glue omits it; unknown query accepted otherwise — probed).
- [CONV] operationResolver (not serviceHandlers) so a missing handler fails boot; response validation = core preSerialization hook behind LIMS_CORE_RESPONSE_VALIDATION.
- Tests: node --test tests/spikes/SP-{1,2,3,5,8}.decision.test.mjs → 88/88 pass.
- Open: Fastify 5.12.8 pin to be confirmed at T0-03; TS types (index.d.ts vs generated Operations) not probed.
