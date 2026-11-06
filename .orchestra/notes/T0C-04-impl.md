# T0C-04 impl
- Files: contracts/openapi/{_common,core}.yaml; tools/codegen/{lint-openapi.ts,package.json}; tools/codegen/vendor/{oas-3.0-schema.yaml,README.md} (OAI commit 4f86429f, draft-04, validated with ajv-draft-04).
- Tests: `cd tools/codegen && npm install && npx vitest run __tests__/lint-openapi.test.ts` — 128/128 pass; `node tools/codegen/lint-openapi.ts` on repo exits 0.
- [CONV] action endpoint (rule 7 `status`) = POST on `/…/{id}/<action>` or `/…/bulk-<action>`; rule 8 also checks x-edge-exposure, x-anonymous-tx, x-raw-body, text/html, x-upload (⊆ CV §10.2); AB-20 = Nepali-mobile (opt. +977) + e-mail regex over all example values.
- [CONV] _common: IdempotencyKey/IfMatch `required: true` (no $ref siblings allowed); Problem requires request_id; paymentCallbackToken declared `in: query` named callback_token (OAS 3.0 apiKey has no path location; 08 R10 says path param) — description says so.
- [CONV] core.yaml: Readiness.status/checks enum ok|degraded|down; 503 readiness returns the Readiness body, liveness 503 → _common ServiceUnavailable.
- Open: lintRepo portConsumers = {} until T0C-05 emits PORT_CONSUMERS; root package.json/pnpm (0A) absent so deps live in tools/codegen/package.json; no tsc run (typescript not installed).
