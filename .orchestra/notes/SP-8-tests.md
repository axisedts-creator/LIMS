# SP-8 tests
- File: tests/spikes/SP-8.decision.test.mjs (node:test, no deps; same layout as SP-1/2/3/5)
- Run: `node --test tests/spikes/SP-8.decision.test.mjs`
- Checks db/meta/decisions/SP-8.md: Decision as-designed|route-metadata-map, exact fastify-openapi-glue 4.12.0 + Fastify x.y.z with command output, 12 probed features each with a verdict (3.0.3 mount, securitySchemes, x-* extensions, additionalProperties:false, multipart, operationId handler lookup, per-scheme security handler, x-permission/x-idempotency/x-rate-limit-tier access, response-validation toggle, validation error shape).
- Conditional: as-designed -> every feature passing; fallback -> gap named, operationId-keyed pre-parsed map, still mounted through the glue.
- Also: x-* access method, multipart path, common.* error code, T0D-01 hand-off, no secrets.
- Expected now: all fail with "db/meta/decisions/SP-8.md must exist" (verified by run).
- Live glue behaviour not unit-testable; record checked structurally only.
