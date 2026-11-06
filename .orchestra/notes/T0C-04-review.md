APPROVE

Re-review after 72b5def / ecd974a. Item 1 (local `$ref` requestBody bypassing rules 4/7/8) fixed at tools/codegen/lint-openapi.ts:226-229; `body` now resolves `#/components/requestBodies/X`, feeding rules 4, 7 and 8 (upload). New fixtures: $ref+tenant_id → rule 7, $ref without example → rule 4, clean $ref → no violations.
Ran: vitest 131/131 pass; `node tools/codegen/lint-openapi.ts` on repo exits 0.
Earlier round still holds: names verbatim vs 02-TRD §5.1/§8 and 08 R10; rules 1–8, P-23, P-8, D-212; only C0-0C paths; no secrets or PHI.
Non-blocking: cross-file `$ref` requestBodies/schemas (e.g. `_common.yaml#/...`) are not followed, same as local-only schema deref. Revisit if module specs start using them. `portConsumers: {}` stays until T0C-05. Vendored OAS schema not byte-compared to upstream.
