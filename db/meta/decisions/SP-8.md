# SP-8 — fastify-openapi-glue 4.12.0 fit

- Date run: 2026-11-06 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-8 · 02-TRD §2.2 (Fastify pin), §5.2, §6.1, §6.2, §6.3, §11 · 02-CV §4 (error body), 04 T7, REQ-ARCH-071, REQ-SEC-080
- Method: throwaway project (not committed), fastify-openapi-glue 4.12.0 + Fastify 5.12.8 + @fastify/multipart 9.4.0; one OpenAPI 3.0.3 spec with 3 operations (JSON POST, GET with query, multipart POST) and one operation without a handler; requests sent with `app.inject()`.
- Hand-off: unblocks **T0D-01** (gated by SP-8). Input for `services/api/src/core/openapi.ts` and `core/DECISIONS.md`.

## Decision

Decision: **as-designed** — mount every `contracts/openapi/<m>.yaml` through fastify-openapi-glue 4.12.0; no route-metadata map needed. All 12 probed features are reachable through the glue plus standard Fastify hooks. The core must apply the five settings in "Core obligations" below; without them three features behave wrongly (silent strip of unknown body fields, unknown query params accepted, missing handler found only at request time).

## Versions (exact)

- fastify-openapi-glue **4.12.0** (no `peerDependencies`; its `fastify-plugin` registration declares a minimum Fastify of 4.0.0, so Fastify 5 is supported).
- Fastify **5.12.8** — compatible with the glue, recommended as the C0 Fastify pin for T0-03 (02-TRD §2.2: "must be a major supported by fastify-openapi-glue 4.12.0").
- Under Fastify 5.12.8: `@fastify/ajv-compiler` 4.0.7, `ajv` 8.20.0, `fast-json-stringify` 7.3.1. Multipart: `@fastify/multipart` 9.4.0.
- Node v25.8.0, npm 11.11.0 on the spike host.

```text
$ npm ls --depth=0
sp8-spike@1.0.0
+-- @fastify/multipart@9.4.0
+-- fastify-openapi-glue@4.12.0
`-- fastify@5.12.8

$ npm ls ajv
+-- fastify-openapi-glue@4.12.0
| `-- @seriousme/openapi-schema-validator@2.11.0
|   `-- ajv@8.20.0
`-- fastify@5.12.8
  +-- @fastify/ajv-compiler@4.0.7
  | `-- ajv@8.20.0 deduped
  `-- fast-json-stringify@7.3.1
    `-- ajv@8.20.0 deduped
```

## Spike spec (mounted)

`openapi: 3.0.3`; `components.securitySchemes`: `bearerJwt` (http bearer), `bffSession` (apiKey header `X-Lims-Bff-Key`), `deviceToken` (apiKey header). Operations `createSampleItem` (POST, `bearerJwt`, `x-permission`, `x-idempotency: required`, `x-rate-limit-tier: general`), `listSampleItems` (GET, `deviceToken`, `limit` integer 1–200), `uploadSampleFile` (POST multipart/form-data, `bffSession`, `x-public`, `x-upload: [application/pdf]`, `x-rate-limit-tier: ingest`), `notWired` (no handler). Every object schema `additionalProperties: false`.

## Feature verdicts

| # | Feature | Verdict and evidence |
|---|---|---|
| 1 | 3.0.3 spec mount | pass — the glue validates the 3.0.3 spec at register time (`@seriousme/openapi-schema-validator`) and mounts every path; `{id}` becomes `:id`; each GET also gets a HEAD route from Fastify (`exposeHeadRoutes`) |
| 2 | `securitySchemes` | pass — `components.securitySchemes` is passed to `securityHandlers.initialize(schemes)` (seen: `bearerJwt`, `bffSession`, `deviceToken`) |
| 3 | `x-*` extensions | pass — every operation-level `x-*` key is copied onto the Fastify route `schema` (Parser.v3 `makeSchema`) |
| 4 | `additionalProperties: false` | pass with obligation O1 — unknown body field `zzz` → 400 (`keyword: additionalProperties`). With Fastify's default ajv options (`removeAdditional: true`) the same request returned 200 and the field was silently stripped |
| 5 | multipart | pass — `multipart/form-data` body mounted; with `@fastify/multipart` (`attachFieldsToBody: true`) the file part reaches the handler (`mimetype: application/pdf`) and the body schema is enforced (missing `file` → 400). Without a parser the glue only logs `ContentTypeParser for 'multipart/form-data' not found` |
| 6 | handler lookup by operationId | pass — `operationResolver(operationId, method, path)` (or `serviceHandlers[operationId]`); works with obligation O3 for boot-time checking |
| 7 | security handler per scheme | pass — one handler per scheme name, run as the route `preHandler`; OR across `security[]` entries, AND inside one entry; the scopes array is passed as the third argument. Missing token on `bearerJwt` / `deviceToken` → 401 `SecurityError` (`name: Unauthorized`, `errors[]` = the handler errors) |
| 8 | `x-permission` access per route | pass — reachable as `request.routeOptions.schema['x-permission']` in hooks/handler and as `routeOptions.schema['x-permission']` in `onRoute` (seen `sample.item.create`) |
| 9 | `x-idempotency` access per route | pass — same path, `schema['x-idempotency']` (seen `required`, `none`, `optional`) |
| 10 | `x-rate-limit-tier` access per route | pass — same path, `schema['x-rate-limit-tier']` (seen `general`, `ingest`) |
| 11 | response validation toggle | pass with obligation O4 — the glue has no response validation of its own: Fastify uses the response schema only for serialization (fast-json-stringify strips the extra field, 201 `{"id":"x"}` with toggle off). Core `preSerialization` hook compiling `routeOptions.schema.response[status].content['application/json'].schema` → 500 `common.internal` on mismatch with toggle on; toggle off → no check |
| 12 | validation error shape | pass with obligation O5 — Fastify sets `err.validation` (ajv errors: `keyword`, `instancePath`, `params`); the core error handler maps it to the 02-CV error body `400 common.validation_failed` with `errors[]` (seen: `additionalProperties`, `required`, `maxLength`, `maximum`) |

## Core obligations (input for T0D-01 `core/openapi.ts`)

- **O1 ajv options** [CONV]: `Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: true } } })`. `removeAdditional: false` is mandatory (REQ-SEC-080; matches `@lims/shared-ts/validation`). `coerceTypes: 'array'` (Fastify default) is required for integer query/path params (`coerceTypes: false` rejected `limit=5`). `allErrors: true` is bounded by the §5.2 lint (every string `maxLength`, every array `maxItems`).
- **O2 strict query/params**: the glue builds `querystring`/`params`/`headers` schemas without `additionalProperties`. Probe: unknown query param `foo` → 200 without the fix, 400 with an `onRoute` hook that sets `schema.querystring.additionalProperties = false` (02-CV: unknown query params → `400 common.validation_failed`). Do not set it on `headers` (browsers/proxies add headers).
- **O3 boot-time handler check**: use `operationResolver` (not `serviceHandlers`); it throws when a module's `operationId → handler` map lacks an operation, so register fails (`missing handler listSampleItems` seen at `ready()`). With `serviceHandlers` the glue mounts a stub and the request returns 500 at run time. The resolver also wraps the module handler so `HandlerResult { status, body, headers }` is applied to `reply` (the glue itself does not set status codes). This is the T0D-01 "missing handler fails boot" check.
- **O4 response validation toggle**: `LIMS_CORE_RESPONSE_VALIDATION` (02-TRD §11): default `on` in dev/ci/staging, `off` in production. When on, the core `preSerialization` hook validates and on mismatch returns `500 common.internal` and logs `response_contract_violation` (02-TRD §6.2 stage 12). Option read once at boot.
- **O5 error mapping** (`setErrorHandler`): `err.validation` → `400 common.validation_failed`, `errors[]` with JSON-Pointer `path` and sub-code `common.unknown_field` (ajv `additionalProperties`), `common.field_required` (`required`), else `common.field_invalid`; `SecurityError` (401) → `auth.unauthenticated` (or the code the resolver threw); request-time missing handler → `500 common.internal`. No new codes.

## Notes

- Order: spec validation runs before the security `preHandler`, so an anonymous request with a bad body gets 400 before 401. This matches 02-TRD §6.2 (stage 3 before stage 4).
- x-* access method: read from `request.routeOptions.schema` per request; the core may also collect per-route metadata in an `onRoute` hook at boot (skip `HEAD` duplicates, which carry the same `operationId`). Specs are not pre-parsed by the core.
- Multipart: register `@fastify/multipart` before the glue with `limits.fileSize` 15 MB (02-TRD §6.2 stage 2, CV §10.2); `x-upload` MIME allowlist is enforced by the core / `ctx.uploads.accept`, not by the glue.
- The glue warns for any security scheme without a handler and that route then throws on every request; the core must register a handler for each of the 7 scheme names in 02-TRD §6.2 (`bearerJwt`, `bffSession`, `deviceToken`, `queueDisplayToken`, `portalSession`, `patientPreAuth`, `paymentCallbackToken`).
- `x-no-fastify-config` on an operation makes the glue skip it; the §5.2 lint should reject it. `x-fastify-config` is copied to route `config`; not used by LIMS.
- Not covered by this spike: the full TypeScript types (`index.d.ts`) with the generated `Operations` type; spec mount time with all module specs.
