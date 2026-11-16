# T0A-HEADERS-1 impl (writer)
- Changed: `services/api/src/core/openapi.ts` only — `buildValidator` compiles `httpPart === 'headers'` from a copy (`lowerCaseHeaders`) with top-level `properties` keys and `required` entries lower-cased; body/query/params unchanged; input schema not mutated. Comment cites LD-277/LD-278.
- [CONV] Transform is top-level only (task brief), not Fastify's full recursive lowerCaseHeadersSchema; no contract uses nested header schemas.
- Checks: `.orchestra/notes/T0A-HEADERS-1-verify.cmd` 3 files / 21 tests pass; `tsc --noEmit` clean.
- Contract test count: operations with a required header 535; If-Match 324; Idempotency-Key 280; X-Lims-* 46 — all accepted with lower-case headers, each dropped required header refused.
- No new error code; no change to idempotency/If-Match handling, contracts, auth, RLS, migrations.
- The second sweep (T0B-SWEEP-2) can be reset.
- LD-278: founder must not retry the Provision form until BOTH T0A-HEADERS-1 and PLATFORM-PROVISION-1 are merged into main.
