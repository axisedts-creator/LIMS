// T-12 (C3) shared test setup: panels + packages (#52–#56) and resolveOrderablesPreview (#3) over the SQL fake (helpers/testsDb.ts, extended for T-12).
// Synthetic data only. SEAM (spec silent on names; see .orchestra/notes/T-12-tests.md):
//   catalog/service/panels.service.ts  export function createPanelsService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createTestsService):
//        listPanels(ctx, query)                                  query = { panel_kind?, is_active?: 'true'|'false'|'all', cursor?, limit? }   -> { data: Panel[], page: { limit, next_cursor? } }
//        createPanel(ctx, body)                                  body = PanelCreate as sent                                                   -> Panel (the 201 body)
//        getPanelDetail(ctx, { id })                                                                                                          -> Panel
//        updatePanel(ctx, { id, expectedVersion, patch })        expectedVersion = integer from If-Match, undefined = header absent            -> Panel
//        replacePanelMembers(ctx, { id, expectedVersion, body }) body = { members }                                                           -> Panel
//        resolveOrderablesPreview(ctx, body)                     body = { orderable_ids, as_of? }                                             -> ResolvedOrderables (snake_case)
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }; "now" is ctx.now(). Errors are LimsError. The service does not
//     check permissions (x-permission is the pipeline's). Every write calls revision.service.bumpRevision (entityType 'panel', entityId = the panel id) in
//     the SAME tx and stamps the panel's own orderables.revision; reads write nothing. The panel `version` (If-Match) is catalog.panels.version.
//   catalog/domain/panelGraph.ts: see domain/__tests__/panelGraph.test.ts.
import { createEvents } from '../../../../core/events/publish.js';
import { createPanelsService } from '../../service/panels.service.js';
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { cont, spec as specimen } from './mastersDb.js';
import { ID, ana, anv, makeTestsDb, pmb, pnl, tsr, tst, type Row, type T6Table } from './testsDb.js';
import { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState } from './t6.js';

export { BIOC, EDTA, EDTA_B, HAEM, HAEM_B, LAV, LAV_B, SERUM, seedState, ID, pmb, pnl, tsr, tst };
export { ISO_UTC, errPaths, events, lims, rejection, validation400 } from './t6.js';
export const T = 20_000;
/** ctx.now() of the fake. */
export const NOW = '2026-11-07T12:00:00.000Z';
export const T0 = '2026-01-01T00:00:00.000Z';
export const SEED_REVISION = 417;

export const FLP = specimen(7, TENANT_A, { code: 'FL_PLASMA' });
export const GRY = cont(5, TENANT_A, { code: 'GREY_TOP' });

// ---- tests of tenant A
export const TC = tst(1, TENANT_A, BIOC.id, { code: 'TC', name: 'Total cholesterol' });
export const HDL = tst(2, TENANT_A, BIOC.id, { code: 'HDL', name: 'HDL cholesterol' });
export const TG = tst(3, TENANT_A, BIOC.id, { code: 'TG', name: 'Triglycerides' });
export const LDL = tst(4, TENANT_A, BIOC.id, { code: 'LDL', name: 'LDL cholesterol' });
export const CBC = tst(5, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count' });
export const FBS = tst(6, TENANT_A, BIOC.id, { code: 'FBS', name: 'Fasting blood sugar' });
export const ADDON = tst(7, TENANT_A, HAEM.id, { code: 'ADDON', name: 'Add-on on existing material', uses_existing_material: true });
export const OLD = tst(8, TENANT_A, BIOC.id, { code: 'OLD', name: 'Retired test', is_active: false });
export const A1C = tst(9, TENANT_A, HAEM.id, { code: 'A1C', name: 'HbA1c' });
export const TEST_B = tst(20, TENANT_B, HAEM_B.id, { code: 'BTEST', name: 'Tenant B only test' });
export const ALL_TESTS = [TC, HDL, TG, LDL, CBC, FBS, ADDON, OLD, A1C];

// ---- panels of tenant A: LIPID {TC, HDL, TG, LDL}; HP_ELITE_M (package, male) {CBC, LIPID, FBS}; BASIC {CBC, FBS}; DEAD (inactive) {TC}
export const LIPID = pnl(1, TENANT_A, { code: 'LIPID', name: 'Lipid profile', panel_kind: 'clinical', department_id: BIOC.id });
export const HP_ELITE_M = pnl(2, TENANT_A, { code: 'HP_ELITE_M', name: 'Health package elite male', panel_kind: 'package', sex_restriction: 'male' });
export const BASIC = pnl(3, TENANT_A, { code: 'BASIC', name: 'Basic screen', panel_kind: 'clinical' });
export const DEAD = pnl(4, TENANT_A, { code: 'DEAD', name: 'Retired panel', panel_kind: 'clinical', is_active: false });
export const PANEL_B = pnl(20, TENANT_B, { code: 'BPANEL', name: 'Tenant B panel', panel_kind: 'clinical' });
export const ALL_PANELS = [LIPID, HP_ELITE_M, BASIC, DEAD];
export const mem = (kind: 'test' | 'panel', orderableId: string, sortOrder: number) => ({ kind, orderable_id: orderableId, sort_order: sortOrder });

const MEMBERS: Row[] = [
  pmb(LIPID.panel.id, TC.test.id, TENANT_A, 1), pmb(LIPID.panel.id, HDL.test.id, TENANT_A, 2), pmb(LIPID.panel.id, TG.test.id, TENANT_A, 3), pmb(LIPID.panel.id, LDL.test.id, TENANT_A, 4),
  pmb(HP_ELITE_M.panel.id, CBC.test.id, TENANT_A, 1), pmb(HP_ELITE_M.panel.id, LIPID.panel.id, TENANT_A, 2), pmb(HP_ELITE_M.panel.id, FBS.test.id, TENANT_A, 3),
  pmb(BASIC.panel.id, CBC.test.id, TENANT_A, 1), pmb(BASIC.panel.id, FBS.test.id, TENANT_A, 2),
  pmb(DEAD.panel.id, TC.test.id, TENANT_A, 1),
  pmb(PANEL_B.panel.id, TEST_B.test.id, TENANT_B, 1),
];
/** Preferred specimen requirement per test: serum (no container) for the chemistry tests, EDTA + lavender for haematology, FL plasma + grey top for FBS; ADDON has none. */
const SPECIMENS: Row[] = [
  ...[TC, HDL, TG, LDL, OLD].map((t) => tsr(t.test.id, SERUM.id, TENANT_A, { is_preferred: true })),
  tsr(CBC.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 }), tsr(CBC.test.id, SERUM.id, TENANT_A, { is_preferred: false }),
  tsr(A1C.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id }),
  tsr(FBS.test.id, FLP.id, TENANT_A, { is_preferred: true, container_id: GRY.id }),
  tsr(TEST_B.test.id, EDTA_B.id, TENANT_B, { is_preferred: true, container_id: LAV_B.id }),
];
/** One analyte with a published version on CBC (so TestDefinition.analytes is not always empty). */
export const HB = ana(1, TENANT_A, CBC.test.id, { code: 'HB', name: 'Hemoglobin', sort_order: 10, report_subheading: 'RBC parameters' });
export const HB_V1 = anv(1, TENANT_A, HB.id, { version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, effective_from: new Date(T0), published_at: new Date(T0), change_reason: 'initial' });

type Rows = Partial<Record<T6Table, Row[]>>;
const BASE: Rows = {
  orderables: [...ALL_TESTS.map((t) => t.orderable), TEST_B.orderable, ...ALL_PANELS.map((p) => p.orderable), PANEL_B.orderable],
  tests: [...ALL_TESTS.map((t) => t.test), TEST_B.test], panels: [...ALL_PANELS.map((p) => p.panel), PANEL_B.panel],
  panel_members: MEMBERS, test_specimen_types: SPECIMENS, analytes: [HB], analyte_versions: [HB_V1],
};
const merge = (a: Rows, b: Rows): Rows => Object.fromEntries((Object.keys({ ...a, ...b }) as T6Table[]).map((k) => [k, [...(a[k] ?? []), ...(b[k] ?? [])]]));

export type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
export interface Setup12 { t6?: Rows; base?: boolean; catalog?: any }
/** World: see the consts above. `t6` ADDS rows to the base world; `base: false` starts with no seeded tests/panels (only what `t6` adds). */
export const setup12 = (s: Setup12 = {}) => {
  const db = makeTestsDb({
    rows: { departments: [HAEM, BIOC, HAEM_B], specimen_types: [EDTA, SERUM, EDTA_B, FLP], containers: [LAV, LAV_B, GRY] },
    t6: merge(s.base === false ? {} : BASE, s.t6 ?? {}), catalog: s.catalog ?? seedState,
  });
  const svc = createPanelsService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
export type Env12 = ReturnType<typeof setup12>;

export const pBody = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({
  code: 'newp', name: 'New panel', panel_kind: 'clinical', members: [mem('test', TC.test.id, 1), mem('test', HDL.test.id, 2)],
  ...o,
}).filter(([, v]) => v !== undefined));

/** Member orderable ids of a panel, as committed, in sort_order. */
export const membersOf = (db: Env12['db'], panelId: string): string[] =>
  db.rows('panel_members').filter((r) => r['panel_id'] === panelId).sort((a, b) => a['sort_order'] - b['sort_order']).map((r) => r['member_orderable_id']);
/** Statements on panels / panel_members. */
export const panelStmts = (db: Env12['db']) => db.t6Stmts().filter((s) => /catalog\.(panels|panel_members)\b/i.test(s.text));

/** n nested panels `${prefix}1 ⊃ ${prefix}2 ⊃ … ⊃ ${prefix}n ⊃ test CBC` (tenant A). Returns the rows to ADD and the panel ids, outermost first. */
export function chainSeed(prefix: string, n: number, firstNo = 100): { rows: Rows; ids: string[] } {
  const ps = Array.from({ length: n }, (_v, i) => pnl(firstNo + i, TENANT_A, { code: `${prefix.toUpperCase()}${i + 1}`, name: `${prefix} ${i + 1}` }));
  return {
    ids: ps.map((p) => p.panel.id),
    rows: { orderables: ps.map((p) => p.orderable), panels: ps.map((p) => p.panel),
      panel_members: ps.map((p, i) => pmb(p.panel.id, i + 1 < n ? ps[i + 1]!.panel.id : CBC.test.id, TENANT_A, 1)) },
  };
}
