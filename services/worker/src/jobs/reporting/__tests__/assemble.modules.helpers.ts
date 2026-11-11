// C6-T32 test helpers (not a test file). Synthetic data only. Adds a micro item and an anatomic item (lab-ready, approved, ResultView.moduleRef set) to the T08 world
// WITHOUT touching its helpers: report_order_items rows go straight into the fake store, the three ports are wrapped after setup() (same technique as assemble_report.test.ts).
import { SYSTEM_ACTOR, type Row } from './consumers.helpers.js';
import { TENANT_A, TENANT_B, I, idN, setup, type Setup, type WorldOpts } from './assemble.helpers.js';

export { TENANT_A, TENANT_B, I, idN };
export const ITEM_MICRO = idN(0x3a02); export const T_MICRO = idN(0x3a01); export const MICRO_ENTITY = idN(0x3b01);
export const ITEM_ANAT = idN(0x3a12); export const T_ANAT = idN(0x3a11); export const ANAT_ENTITY = idN(0x3b11);
export const DEPT_MICRO = idN(0x3a20);
const ctxBase = { tenant_id: TENANT_A, centre_id: I.centre, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };

export const microRow = (over: Row = {}): Row => ({
  tenant_id: TENANT_A, entity_id: MICRO_ENTITY, version_no: 2, order_item_id: ITEM_MICRO, report_phase: 'final',
  culture_summary_text: 'SYNTH-CULT-V2 growth of E. coli', isolates: [{ seq: 1, organism_code: 'ESCH_COLI', organism_display: 'Escherichia coli (synthetic)', growth_text: '>10^5 CFU/mL' }],
  ast: [{ isolate_seq: 1, antibiotic_code: 'CIP', antibiotic_display: 'Ciprofloxacin (synthetic)', method: 'zone_diameter', raw_value: '14', category_code: 'R', standard: 'CLSI', standard_version: 'M100-SYN' }],
  comments_text: 'SYNTH-MICRO-COMMENT', signed_by_membership_id: I.m1, signed_at: '2026-11-07T09:00:00.000Z', ...over,
});
export const anatRow = (over: Row = {}): Row => ({
  tenant_id: TENANT_A, entity_id: ANAT_ENTITY, version_no: 1, order_item_id: ITEM_ANAT, accession_no: 'SYN-AP-26-0001', case_kind: 'histology',
  gross_text: 'SYNTH-GROSS', microscopy_text: 'SYNTH-MICROSCOPY', impression_text: 'SYNTH-IMPRESSION-V1', synoptic: [], clinical_history_text: 'SYNTH-HISTORY', comment_text: null,
  specimen_parts: [], slides: [], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [],
  images: [{ bucket: 'anatomic-images', object_path: `${TENANT_A}/2026/11/img1.jpg`, sha256: 'e'.repeat(64), caption: 'SYNTH-CAPTION' }],
  version_kind: 'original', scope: 'full', change_reason_code: null, signed_by_membership_id: I.m1, signed_at: '2026-11-07T09:10:00.000Z', ...over,
});

export interface ModuleOpts { micro?: boolean; anatomic?: boolean; microRows?: Row[]; anatRows?: Row[]; rls?: boolean; smartFlag?: boolean; microPhase?: 'preliminary' | 'final'
  /** reason code of ResultView.amendment on the module result (03-IC ResultView) */ microAmend?: string; anatAmend?: string; /** extra world options, e.g. an earlier released version */ world?: Partial<WorldOpts> }
export const amendOf = (reasonCode: string): Row => ({ previousVersionNo: 1, reasonCode, reasonText: 'Synthetic module amendment', amendedAt: '2026-11-07T09:45:00.000Z' });
/** setup() + module items. Defaults: both items present, one view row each (micro version 2 with a stale version 1 beside it). */
export function moduleSetup(o: ModuleOpts = {}): Setup {
  const s = setup({ ...(o.world ?? {}), ...(o.rls === undefined ? {} : { rls: o.rls }), ...(o.smartFlag ? { smartFlag: true } : {}) });
  const withMicro = o.micro ?? true; const withAnat = o.anatomic ?? true;
  const store = s.db.store;
  const item = (n: number, orderItem: string, test: string): Row => ({ ...ctxBase, id: idN(0xb100 + n), report_id: idN(0xa101), order_id: I.order, order_item_id: orderItem, orderable_id: test, orderable_kind: 'test',
    test_ids: [test], narrative_test_ids: [], item_status: 'active', approved_results: 1, amendment_pending: false, version: 1, priority: 'routine', requires_lab: true, requires_narrative: false, requires_outsourced: false, lab_ready: true, narrative_ready: false, outsourced_ready: false, items_version: 1 });
  (store['reporting.report_order_items'] ??= []).push(...(withMicro ? [item(11, ITEM_MICRO, T_MICRO)] : []), ...(withAnat ? [item(12, ITEM_ANAT, T_ANAT)] : []));
  store['micro.v_pub_report_content'] = o.microRows ?? [microRow({ version_no: 1, culture_summary_text: 'SYNTH-CULT-V1 STALE', report_phase: 'preliminary' }), microRow({ report_phase: o.microPhase ?? 'final' })];
  store['anatomic.v_pub_report_content'] = o.anatRows ?? [anatRow()];

  const p = s.ports.ports as any;
  const summary0 = p.frontdesk.getOrderSummary; const test0 = p.catalog.getTest; const lab0 = p.lab.getOrderResults;
  const it = (orderItemId: string, test: string) => ({ orderItemId, orderableId: test, orderableKind: 'test', testIds: [test], priority: 'routine', status: 'active', outsourced: false });
  p.frontdesk.getOrderSummary = async (c: unknown, i: unknown) => { const r = await summary0(c, i); r.items.push(...(withMicro ? [it(ITEM_MICRO, T_MICRO)] : []), ...(withAnat ? [it(ITEM_ANAT, T_ANAT)] : [])); return r; };
  const def = (id: string, code: string, name: string, deptId: string, deptName: string, wf: string) => ({ id, code, name, departmentId: deptId, departmentName: deptName, departmentCode: code, specimenTypeCodes: ['URINE'], workflowType: wf, analytes: [], isActive: true, revision: 1 });
  p.catalog.getTest = async (c: unknown, i: any) => i.testId === T_MICRO ? def(T_MICRO, 'CULT', 'Synthetic urine culture', DEPT_MICRO, 'Microbiology', 'microbiology')
    : i.testId === T_ANAT ? def(T_ANAT, 'HISTO', 'Synthetic skin biopsy', idN(0x3a21), 'Histopathology', 'anatomic') : test0(c, i);
  const rv = (n: number, orderItemId: string, testId: string, moduleRef: Row, amendment?: Row): Row => ({ resultId: idN(0x3c00 + n), orderItemId, testId, analyteId: idN(0x3d00 + n), versionNo: 1, status: 'approved', origin: 'module',
    commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false, approvedAt: '2026-11-07T09:30:00.000Z', approvedByMembershipId: I.m1, moduleRef, ...(amendment ? { amendment } : {}) });
  p.lab.getOrderResults = async (c: unknown, i: unknown) => {
    const r = await lab0(c, i);
    if (withMicro) r.items.push({ orderItemId: ITEM_MICRO, testId: T_MICRO, departmentId: DEPT_MICRO, results: [rv(1, ITEM_MICRO, T_MICRO, { module: 'micro', entityId: MICRO_ENTITY, versionNo: 2 }, o.microAmend ? amendOf(o.microAmend) : undefined)] });
    if (withAnat) r.items.push({ orderItemId: ITEM_ANAT, testId: T_ANAT, departmentId: idN(0x3a21), results: [rv(2, ITEM_ANAT, T_ANAT, { module: 'anatomic', entityId: ANAT_ENTITY, versionNo: 1 }, o.anatAmend ? amendOf(o.anatAmend) : undefined)] });
    return r;
  };
  return s;
}

/** Statements that touched a module view. */
export const viewStmts = (s: Setup) => s.db.stmts.filter((x) => /\b(micro|anatomic)\.v_pub_report_content\b/i.test(x.text));
