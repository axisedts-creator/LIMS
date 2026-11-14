// T-07 (C3) shared test setup: analytes + analyte versions over the SQL fake (helpers/testsDb.ts, extended for T-07). Synthetic data only.
// SEAM (spec silent on names; see .orchestra/notes/T-07-tests.md):
//   catalog/service/analyteVersions.service.ts  export function createAnalyteVersionsService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createTestsService):
//        createAnalyte(ctx, { test_id, body })                              body = AnalyteCreate as sent                    -> Analyte (the 201 body)
//        getAnalyte(ctx, { id, as_of? })                                                                                    -> AnalyteDetail
//        updateAnalyte(ctx, { id, expectedVersion, patch })                  expectedVersion = integer from If-Match         -> Analyte
//        createAnalyteVersionDraft(ctx, { analyte_id, body? })               body = AnalyteVersionDraftCreate | undefined    -> AnalyteVersion (the 201 body)
//        updateAnalyteVersionDraft(ctx, { id, expectedVersion, patch })      patch = AnalyteVersionDraftUpdate               -> AnalyteVersion
//        publishAnalyteVersion(ctx, { id, expectedVersion, body })           body = AnalyteVersionPublish                    -> AnalyteVersion
//        discardAnalyteVersionDraft(ctx, { id, expectedVersion })                                                            -> AnalyteVersion
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }; "now" is ctx.now() (ISO string), never the wall clock.
//     Errors are LimsError. The service does NOT check permissions (the handler does: handlers/analyteVersions.handlers.ts, 02-TRD §5.2 #34).
//   Writes that change consumer-visible data call revision.service.bumpRevision in the SAME tx, entityType 'analyte', entityId = the ANALYTE id, and
//   stamp orderables.revision of the OWNING test (02-TRD §3): createAnalyte 'created', updateAnalyte 'updated'|'deactivated', publish 'versioned'
//   (effective_from = the version's). Draft writes (create/update/discard of a draft version) bump nothing and emit nothing (02-TRD §3, §9.1).
import { createEvents } from '../../../../core/events/publish.js';
import { createAnalyteVersionsService } from '../../service/analyteVersions.service.js';
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { meth } from './mastersDb.js';
import { ID, ana, anv, makeTestsDb, pnl, tst, type Row, type T6Table } from './testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState } from './t6.js';

export { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState, ID, ana, anv, pnl, tst };
export const T = 20_000;
/** ctx.now() of the fake. */
export const NOW = '2026-11-07T12:00:00.000Z';
export const NOW_MS = Date.parse(NOW);
export const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();
export const SEC = 1000, DAY = 86_400_000;
export const T0 = '2026-01-01T00:00:00.000Z';                // effective_from of the seeded published versions
export const T1 = '2026-12-01T00:00:00.000Z';                // a scheduled (future) effective_from
export const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

export const M1 = meth(1, TENANT_A, { code: 'PHOTOMETRY' });
export const M2 = meth(2, TENANT_A, { code: 'IMPEDANCE' });
export const M_B = meth(3, TENANT_B, { code: 'PHOTOMETRY' });

export const CBC = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count' });
export const MICRO = tst(2, TENANT_A, HAEM.id, { code: 'MICRO', name: 'Culture', workflow_type: 'microbiology' });
export const TEST_B = tst(3, TENANT_B, HAEM_B.id, { code: 'CBCB', name: 'Tenant B only' });
export const PANEL = pnl(1, TENANT_A, { code: 'CBCP', name: 'CBC panel' });

export const HB = ana(1, TENANT_A, CBC.test.id, { code: 'HB', name: 'Hemoglobin', sort_order: 10, report_subheading: 'RBC parameters' });
export const RBC = ana(2, TENANT_A, CBC.test.id, { code: 'RBC', name: 'Red cell count', sort_order: 20 });
export const HB_B = ana(3, TENANT_B, TEST_B.test.id, { code: 'HBB', name: 'Tenant B hemoglobin' });
export const ONLY_B = ana(4, TENANT_B, TEST_B.test.id, { code: 'ONLYB', name: 'Only tenant B' });

/** A draft version row (a draft carries no published_* / effective_from / change_reason). */
export const draftOf = (n: number, analyteId: string, o: Row = {}): Row =>
  anv(n, TENANT_A, analyteId, { version_no: 2, status: 'draft', result_type: 'numeric', unit_code: 'g_dl', decimals: 2, method_id: M1.id, effective_from: null, published_at: null, change_reason: null, ...o });
/** A published version row (defaults: HB-style numeric g_dl, 1 decimal, M1, effective since T0). */
export const pubOf = (n: number, analyteId: string, o: Row = {}): Row =>
  anv(n, TENANT_A, analyteId, { version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_id: M1.id, effective_from: new Date(T0), published_at: new Date(T0), published_by: ID(0xa1), change_reason: 'initial', ...o });

export const HB_V1 = pubOf(1, HB.id);                                  // ID(0x4001)
export const HB_V2 = draftOf(2, HB.id);                                // ID(0x4002): decimals 2, same unit/method
export const RBC_V1 = pubOf(3, RBC.id, { decimals: 2, unit_code: '10e12_l' });
export const B_V1 = pubOf(4, HB_B.id);

/** Coded sets: global (no tenant): URINE_SEMIQ ordered, POS_NEG unordered; tenant A: MY_ORD ordered; tenant B: B_ORD ordered (invisible to A). */
export const VALUE_SETS: Partial<Record<T6Table, Row[]>> = {
  g_value_sets: [{ id: ID(0x5001), code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true }, { id: ID(0x5002), code: 'POS_NEG', display: 'Positive/negative', is_ordered: false }],
  cs_value_sets: [{ id: ID(0x5003), tenant_id: TENANT_A, code: 'MY_ORD', display: 'My ordered set', is_ordered: true }, { id: ID(0x5004), tenant_id: TENANT_B, code: 'B_ORD', display: 'B ordered', is_ordered: true }],
};

export type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
export interface Setup7 { t6?: Partial<Record<T6Table, Row[]>>; base?: boolean }

const BASE: Partial<Record<T6Table, Row[]>> = {
  orderables: [CBC.orderable, MICRO.orderable, TEST_B.orderable, PANEL.orderable], tests: [CBC.test, MICRO.test, TEST_B.test], panels: [PANEL.panel],
  analytes: [HB, RBC, HB_B, ONLY_B], analyte_versions: [HB_V1, RBC_V1, B_V1], ...VALUE_SETS,
};
const merge = (a: Partial<Record<T6Table, Row[]>>, b: Partial<Record<T6Table, Row[]>>) =>
  Object.fromEntries((Object.keys({ ...a, ...b }) as T6Table[]).map((k) => [k, [...(a[k] ?? []), ...(b[k] ?? [])]]));

/** World: tests CBC / MICRO (+ a panel) and tenant B's test; analytes HB (v1 published), RBC (v1 published), tenant B's. `t6` ADDS rows; `base: false` starts empty of analytes. */
export const setup7 = (s: Setup7 = {}) => {
  const base = s.base === false ? { orderables: BASE.orderables, tests: BASE.tests, panels: BASE.panels, ...VALUE_SETS } : BASE;
  const db = makeTestsDb({
    rows: { departments: [HAEM, BIOC, HAEM_B], specimen_types: [EDTA, SERUM, EDTA_B], containers: [LAV, LAV_B], methods: [M1, M2, M_B] },
    t6: merge(base, s.t6 ?? {}), catalog: seedState,
  });
  const svc = createAnalyteVersionsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
export type Env7 = ReturnType<typeof setup7>;

export const aBody = (o: Record<string, unknown> = {}, v: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({
  code: 'wbc', name: 'White cell count', sort_order: 30,
  initial_version: Object.fromEntries(Object.entries({ result_type: 'numeric', unit_code: '10e9_l', decimals: 1, ...v }).filter(([, x]) => x !== undefined)),
  ...o,
}).filter(([, x]) => x !== undefined));
export const pBody = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ change_reason: 'method change approved by the pathologist', ...o }).filter(([, x]) => x !== undefined));

/** Statements on analytes / analyte_versions. */
export const aStmts = (db: Env7['db']) => db.t6Stmts().filter((s) => /catalog\.(analytes|analyte_versions)\b/i.test(s.text));
/** Committed analyte_versions rows of the tenant for one analyte, by version_no. */
export const versionsOf = (db: Env7['db'], analyteId: string) => db.rows('analyte_versions').filter((r) => r['analyte_id'] === analyteId).sort((a, b) => a['version_no'] - b['version_no']);
export const orderableRev = (db: Env7['db'], testId: string) => db.orderableRevision(testId);
