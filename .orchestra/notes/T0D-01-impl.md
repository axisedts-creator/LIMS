# T0D-01 impl (writer) — 41/41 tests pass, tsc clean
- Files: services/api/{package.json,tsconfig.json,src/main.ts}, src/core/{config,module,openapi,bootstrap}.ts, src/core/__fixtures__/{sample.yaml,module-sample/index.ts}.
- [CONV] EVENT_PRODUCERS read from `producer` const of contracts/events/*.schema.json until gen-event-types emits contracts/ports/generated/events.ts (T0C); PORT_OWNERS copied from 02-TRD §6.3. `core` is rejected from the modules dir.
- [CONV] Body ajv uses coerceTypes:false (query/path/header keep SP-8 'array'), so `{"name":5}` → 400; via Fastify schemaController + @fastify/ajv-compiler (formats kept).
- [CONV] Response serializer schemas have `required` removed: it still strips undeclared fields (also in production/off) but never 500s; contract check = LIMS_CORE_RESPONSE_VALIDATION only (SP-8 O4). Error body is a stub `common.internal` until T0D-04.
- [CONV] Sample module: spec route `/v1/core/sample/items` (listSampleItems/createSampleItem), public, loaded only ci+flag; main.ts listens on 8080 (C1 `http://api:8080`); LIMS_CORE_LOG_LEVEL parsed (default info).
- Open: CR .orchestra/cr/T0D-01.md (workspace entry + lockfile, C0-0A); core.yaml not mounted until its handlers exist (T0D-10); security handlers T0D-02; HandlerContext is a stub (operationId, log).
