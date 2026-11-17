// T-06 (C3) shared test setup: masters seeds, the tests service over the SQL fake, small assertion helpers. Synthetic data only.
// SEAM (spec silent on names; see .orchestra/notes/T-06-tests.md):
//   catalog/service/tests.service.ts  export function createTestsService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createMastersService):
//        searchOrderables(ctx, query)                                   query = { q, kind?, panel_kind?, department_id?, is_orderable?: boolean,
//                                                                         is_active?: 'true'|'false'|'all', limit?: number }   -> { data: OrderableSummary[] }
//        listTests(ctx, query)                                          query = { department_id?, workflow_type?, is_active?, sort?, cursor?, limit? } -> { data: OrderableSummary[], page }
//        createTest(ctx, body)                                          body = TestCreate as sent                                    -> Test (the 201 body)
//        getTestDetail(ctx, { id, as_of? })                                                                                          -> Test
//        updateTest(ctx, { id, expectedVersion, patch })                expectedVersion = integer from If-Match, undefined = header absent -> Test
//        replaceTestSpecimenRequirements(ctx, { id, expectedVersion, body })   body = { specimen_requirements }                       -> Test
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }. Errors are LimsError. Every write calls
//     revision.service.bumpRevision (entityType 'test') in the SAME tx.
import { expect } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createTestsService } from '../../service/tests.service.js';
import { ROOT_A, TENANT_A, TENANT_B } from './catalogDb.js';
import { cont, dept, spec as specimen, type Row } from './mastersDb.js';
import { makeTestsDb, type T6Table } from './testsDb.js';

export const T = 20_000;
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const HAEM = dept(1, TENANT_A, { code: 'HAEM' });
export const BIOC = dept(2, TENANT_A, { code: 'BIOC' });
export const HAEM_B = dept(3, TENANT_B, { code: 'HAEM' });
export const EDTA = specimen(1, TENANT_A, { code: 'EDTA_WB', report_label: 'EDTA WHOLE BLOOD' });
export const SERUM = specimen(2, TENANT_A, { code: 'SERUM' });
export const EDTA_B = specimen(3, TENANT_B, { code: 'EDTA_WB' });
export const LAV = cont(1, TENANT_A, { code: 'LAV_TOP' });
export const LAV_B = cont(2, TENANT_B, { code: 'LAV_TOP' });
export const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };

export type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
export interface Setup { t6?: Partial<Record<T6Table, Row[]>>; catalog?: any; extraDepts?: Row[] }

export const setup = (s: Setup = {}) => {
  const db = makeTestsDb({
    rows: { departments: [HAEM, BIOC, HAEM_B, ...(s.extraDepts ?? [])], specimen_types: [EDTA, SERUM, EDTA_B], containers: [LAV, LAV_B] },
    t6: s.t6 ?? {}, catalog: s.catalog ?? seedState,
  });
  const svc = createTestsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
export type Env = ReturnType<typeof setup>;

export const body = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({
  code: 'cbc', name: 'Complete blood count', department_id: HAEM.id, workflow_type: 'standard', report_order: 10,
  specimen_requirements: [{ specimen_type_id: EDTA.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000 }],
  ...o,
}).filter(([, v]) => v !== undefined));

export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
export const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
export const errPaths = (e: any): string[] => (e?.errors ?? []).map((x: { path: string }) => x.path);
export const events = (db: Env['db'], tenant = TENANT_A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
/** Statements on the T-06 tables, minus the T-03 revision stamp (repo/catalogState.repo.ts, which binds the id only). */
export const t6Own = (db: Env['db']) => db.t6Stmts().filter((s) => !/^\s*UPDATE\s+catalog\.orderables\s+SET\s+revision\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2\s*$/i.test(s.text.replace(/\s+/g, ' ')));
