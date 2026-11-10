// T-27 (C3) shared test setup = helpers/t27db.ts (world, fixtures) + the instrument-maps service under test.
// SEAM (spec silent on names; see .orchestra/notes/C3.T-27-tests.md):
//   catalog/service/instrumentMaps.service.ts  export function createInstrumentMapsService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createRangesService / createCreditPartiesService):
//        listInstrumentCodeMaps(ctx, query)                           query = { instrument_id (required), direction?, analyte_id?, is_active? 'true'|'false'|'all' (default 'true'), cursor?, limit? }
//                                                                       -> { data: InstrumentCodeMap[], page: { limit, next_cursor? } }
//        createInstrumentCodeMap(ctx, body)                           body = InstrumentCodeMapCreate as sent                    -> InstrumentCodeMap (the 201 body)
//        updateInstrumentCodeMap(ctx, { id, expectedVersion, patch }) expectedVersion = integer from If-Match (undefined -> 428)  -> InstrumentCodeMap
//        upsertInstrumentCodeMaps(ctx, body)                          body = { instrument_id, maps: InstrumentCodeMapRow[1..200] } -> { results: InstrumentCodeMapResult[] }
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }; "now" is ctx.now() (ISO string). Errors are LimsError.
//     The service does NOT check permissions (the handlers do, through ctx.ports.IdentityPort.assertRole — see instrumentMaps.handlers.test.ts).
//     Every create / update / bulk row that changed data bumps the catalog revision in the SAME tx (entityType 'instrument_code_map', 02-TRD §9.1): create 'created',
//     update 'updated' (is_active true -> false: 'deactivated').
//   Handlers: looked up by operationId in handlers/index.ts (`handlers`), wherever the writer puts them.
//   SQL: single table per statement, no joins / casts (see testsDb.ts header). flag_map: DTO = JSON object TEXT (string), column = jsonb object.
import { createEvents } from '../../../../core/events/publish.js';
import { createInstrumentMapsService } from '../../service/instrumentMaps.service.js';
import { world27Db, type Setup27Db } from './t27db.js';

export * from './t27db.js';
export type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
export type Setup27 = Setup27Db;

export const setup27 = (s: Setup27 = {}) => {
  const db = world27Db(s);
  const svc = createInstrumentMapsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
export type Env27 = ReturnType<typeof setup27>;
