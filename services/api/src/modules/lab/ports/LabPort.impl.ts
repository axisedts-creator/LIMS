// T-24: LabPort implementation (03-IC §4.5 + 08 §4.14 + A13 D-5/D-7/D-10 + A17 D-61/A17.2; 02-TRD §6.1; PRD AC-05.8, AC-05.10, AC-14.6, AC-17.5, AC-17.6, AC-19.4, AC-20.1, AC-20.2).
// The manifest object `labPort` has the nine LabPortV1 methods. Other modules call it with a STRICT RequestContext (ctx.tx, ISO-string ctx.now(), ctx.ports): everything runs in the caller's tx under
// RLS with an explicit tenant filter (REQ-SEC-024); the port opens no transaction, logs nothing and writes no access-log row (the calling user-facing action does).
// Order in every method: actor kind (a patient / portal / partner actor is auth.forbidden before any query or port call, REQ-SEC-072, 08 R3) -> input shape -> permission -> reads/writes.
// Errors are codes with fixed text: no barcode, value or name is ever echoed (07-SECURITY P-09, S-17, S-19, S-22).
import { LimsError, isLimsError } from '../../../core/errors.js';
import { approvedSetHash } from '../events/publish.js';
import { loadLabConfig } from '../config.js';
import { first, query } from '../repository/base.repo.js';
import { getLabSettings } from '../repository/labSettings.repo.js';
import { ingestInstrumentResult as runIngest, sqlIngestStore } from '../service/ingest.service.js';
import { submitModuleResult as runModuleSubmit } from '../service/module-result.service.js';
import { bad, instant, isObj, iso, labCtx, portCtx, put, rcOf, uuid, type Obj, type PortCtx } from '../service/port.shared.js';
import { holdResultsSince as runHold } from '../service/qc.service.js';
import { resultSideStore } from '../service/result-side.store.js';
import { emitStatus, step } from '../service/specimen.service.js';

const STAFF = ['user', 'system'] as const;
const BARCODE = /^[A-Za-z0-9]{1,40}$/;   // label alphabet; no quote, space or control character ever reaches a query
const SPECIMEN_STATUSES = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'];
const MAX_IDS = 200, MAX_ANALYTES = 100, MAX_PAGE = 200, DEFAULT_PAGE = 50, SCAN_BATCH = 50, SCAN_BATCHES = 20;

const barcodeOf = (v: unknown): string => { if (typeof v !== 'string' || !BARCODE.test(v)) throw bad('/barcode'); return v; };
async function need(c: PortCtx, permission: string, centreId?: string): Promise<void> {
  if (c.actor.type === 'system') return;   // tenant-wide (system actors have no grants; their module identity is not modelled)
  await c.ports.IdentityPort.assertRole(c, { permission, ...(centreId === undefined ? {} : { centreId }) });
}

// ====================================================================================================================================== getOrderResults
function resultView(r: Obj, attachments: Obj[]): Obj {
  const ap = r['status'] === 'approved', v = ap && r['v_no'] != null;   // approved rows read the latest version (lab.v_result_current cur_*)
  const cur = (k: string): unknown => (v ? r[`cur_${k}`] : r[k]);
  const o: Obj = { resultId: r['id'], orderItemId: r['order_item_id'], testId: r['test_id'], analyteId: r['analyte_id'], versionNo: Number(r['current_version_no']), status: r['status'] };
  put(o, 'valueText', cur('value_text')); put(o, 'valueNumeric', cur('value_numeric')); put(o, 'ordinalCode', cur('ordinal_code')); put(o, 'unitCode', cur('unit_code')); put(o, 'flag', cur('flag'));
  if (cur('ref_range_id') != null) {
    const s: Obj = { referenceRangeId: cur('ref_range_id'), version: Number(cur('ref_range_version')) };
    put(s, 'low', cur('ref_low')); put(s, 'high', cur('ref_high')); put(s, 'text', cur('ref_text'));
    o['referenceRangeSnapshot'] = s;
  }
  o['origin'] = (v ? r['v_origin'] : null) ?? r['origin'];
  put(o, 'instrumentId', r['instrument_id']);
  o['commentCodes'] = r['comment_codes'] ?? []; put(o, 'commentText', r['comment_text']);
  o['attachments'] = attachments.map((a) => ({ bucket: a['bucket'], objectPath: a['object_path'], sha256: a['sha256'], mimeType: a['mime_type'] }));
  o['onHold'] = r['on_hold'] === true; o['qcReviewRequired'] = r['qc_review_required'] === true;
  put(o, 'verifiedAt', iso(r['verified_at'])); put(o, 'verifiedByMembershipId', r['verified_by_membership_id']);
  put(o, 'approvedAt', iso(v ? (r['cur_approved_at'] ?? r['approved_at']) : r['approved_at'])); put(o, 'approvedByMembershipId', (v ? r['v_aby'] : null) ?? r['approved_by_membership_id']);
  if (v && r['v_prev'] != null) {
    const am: Obj = { previousVersionNo: Number(r['v_prev']), reasonCode: r['v_reason'], amendedAt: iso(r['cur_approved_at']) };
    put(am, 'reasonText', r['v_rtext']);
    o['amendment'] = am;
  }
  const mod = v && r['v_mod'] != null ? { module: r['v_mod'], entityId: r['v_ent'], versionNo: r['v_mver'] } : { module: r['module_payload_module'], entityId: r['module_payload_entity_id'], versionNo: r['module_payload_version_no'] };
  if (mod.module != null) o['moduleRef'] = { module: mod.module, entityId: mod.entityId, versionNo: Number(mod.versionNo) };
  return o;
}

async function getOrderResults(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, STAFF);
  const i = isObj(input) ? input : {};
  const orderId = uuid(i['orderId'], '/orderId'), scope = i['scope'];
  if (scope !== 'approved' && scope !== 'all_visible') throw bad('/scope');
  const rc = rcOf(c);
  const order = await first(rc, 'SELECT id, centre_id FROM lab.orders WHERE tenant_id = $1 AND id = $2', [orderId]);
  if (!order) throw new LimsError('common.not_found');   // unknown / other tenant / other centre (P-01)
  if (scope === 'all_visible') await need(c, 'lab.result.read', order['centre_id']);
  const approvedOnly = scope === 'approved';
  const [specimens, items, results] = await Promise.all([
    query(rc, 'SELECT id, specimen_type_code, status, collected_at, received_at, barcode FROM lab.specimens WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id', [orderId]),
    query(rc, 'SELECT DISTINCT ON (order_item_id) order_item_id, test_id, department_id FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $2 ORDER BY order_item_id, id', [orderId]),
    query(rc, `SELECT c.*, rv.version_no AS v_no, rv.origin AS v_origin, rv.module_payload_module AS v_mod, rv.module_payload_entity_id AS v_ent, rv.module_payload_version_no AS v_mver,
          rv.previous_version_no AS v_prev, rv.amendment_reason_code AS v_reason, rv.amendment_reason_text AS v_rtext, rv.approved_by_membership_id AS v_aby
        FROM lab.v_result_current c LEFT JOIN lab.result_versions rv ON rv.tenant_id = c.tenant_id AND rv.result_id = c.id AND rv.version_no = c.current_version_no AND c.status = 'approved'
        WHERE c.tenant_id = $1 AND c.order_id = $2 AND c.status <> 'cancelled' ${approvedOnly ? "AND c.status = 'approved' AND c.is_reportable" : ''}
        ORDER BY c.order_test_id, c.analyte_code, c.id`, [orderId]),
  ]);
  const files = results.length === 0 ? [] : await query(rc, 'SELECT result_id, bucket, object_path, sha256, mime_type FROM lab.result_attachments WHERE tenant_id = $1 AND result_id = ANY($2::uuid[]) ORDER BY created_at, id', [results.map((r) => r['id'])]);
  const approved = approvedOnly ? results : (await query(rc, `SELECT id, current_version_no FROM lab.results WHERE tenant_id = $1 AND order_id = $2 AND status = 'approved' AND is_reportable`, [orderId]));
  return {
    orderId,
    specimens: specimens.map((s) => {
      const o: Obj = { specimenId: s['id'], specimenTypeCode: s['specimen_type_code'], status: s['status'] };
      put(o, 'collectedAt', iso(s['collected_at'])); put(o, 'receivedAt', iso(s['received_at']));
      if (approvedOnly) put(o, 'barcode', s['barcode']);   // P2: scope 'approved' only (08 §4.14)
      return o;
    }),
    items: items.map((it) => ({
      orderItemId: it['order_item_id'], testId: it['test_id'], departmentId: it['department_id'],
      results: results.filter((r) => r['order_item_id'] === it['order_item_id']).map((r) => resultView(r, files.filter((f) => f['result_id'] === r['id']))),
    })),
    approvedSetHash: approvedSetHash(approved.map((r) => ({ result_id: r['id'], version_no: Number(r['current_version_no']) }))),   // exactly the set of approved reportable results, latest versions
  };
}

// ====================================================================================================================================== host query + worklist
/** the analytes (of `ids`) that have an outbound map for the instrument (CatalogPort.mapInstrumentCode, direction outbound); an unmapped analyte is not an error */
async function mapped(c: PortCtx, instrumentId: string, ids: readonly string[], cache: Map<string, boolean>): Promise<void> {
  await Promise.all([...new Set(ids)].filter((a) => !cache.has(a)).map(async (analyteId) => {
    try { await c.ports['CatalogPort'].mapInstrumentCode(c, { instrumentId, direction: 'outbound', analyteId }); cache.set(analyteId, true); }
    catch (e) { if (!isLimsError(e, 'catalog.instrument_code_unmapped')) throw e; cache.set(analyteId, false); }
  }));
}
const testsOf = (rows: readonly Obj[], cache: Map<string, boolean>) => {
  const by = new Map<string, { orderItemId: string; testId: string; analyteIds: string[] }>();
  for (const r of rows) {
    if (!cache.get(r['analyte_id'])) continue;
    const t = by.get(r['order_item_id']) ?? { orderItemId: r['order_item_id'] as string, testId: r['test_id'] as string, analyteIds: [] as string[] };
    t.analyteIds.push(r['analyte_id']);
    by.set(r['order_item_id'], t);
  }
  return [...by.values()];
};
const patientOf = (s: Obj): Obj => ({ sex: s['patient_sex'], ...(s['patient_age_days'] == null ? {} : { ageDays: Number(s['patient_age_days']) }) });

async function getPendingTestsForBarcode(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, ['device', 'system']);
  const i = isObj(input) ? input : {};
  const instrumentId = uuid(i['instrumentId'], '/instrumentId'), barcode = barcodeOf(i['barcode']);
  const rc = rcOf(c);
  let s = await first(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND barcode = $2', [barcode]);
  if (!s) throw new LimsError('lab.specimen_not_found');   // unknown, other tenant, or another centre's specimen (RLS, P-09): the same answer, no barcode in the text
  const requiresReceived = (await getLabSettings(rc))?.['host_query_requires_received'] !== false;
  const early = s['status'] === 'collected' || s['status'] === 'in_transit';
  if (['ordered', 'rejected', 'recollection_ordered', 'discarded'].includes(s['status']) || (early && requiresReceived)) throw new LimsError('lab.specimen_not_receivable');
  if (s['status'] === 'received' || s['status'] === 'aliquoted') {   // S6 pick-up, once: the re-read under the row lock sees a concurrent pick-up
    s = await first(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [s['id']]);
    if (s && (s['status'] === 'received' || s['status'] === 'aliquoted')) {
      const at = c.now(), sc = labCtx(c);
      const { updated } = await step(sc, s, Number(s['version']), 'in_process', { in_process_at: at }, at);
      await emitStatus(sc, updated, s['status'], 'in_process', at);
    }
  }
  if (!s) throw new LimsError('lab.specimen_not_found');
  const sp: Obj = s;
  const pending = await query(rc, `SELECT order_item_id, test_id, analyte_id FROM lab.results WHERE tenant_id = $1 AND specimen_id = $2 AND status IN ('pending','resulted') ORDER BY order_item_id, analyte_id`, [sp['id']]);
  const cache = new Map<string, boolean>();
  await mapped(c, instrumentId, pending.map((r) => r['analyte_id']), cache);
  const order = await first(rc, 'SELECT priority, patient_sex, patient_age_days FROM lab.orders WHERE tenant_id = $1 AND id = $2', [sp['order_id']]);
  return { specimenId: sp['id'], priority: sp['priority'], patient: patientOf(order ?? sp), tests: testsOf(pending, cache) };
}

const cursorOf = (id: string): string => Buffer.from(JSON.stringify({ s: id })).toString('base64url');
function afterOf(v: unknown): string {
  try { const o = JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')); return uuid(o?.s, '/cursor'); } catch { throw bad('/cursor'); }
}

async function listPendingForInstrument(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, ['device', 'system']);   // a device sees its own centre through RLS; system is tenant-wide
  const i = isObj(input) ? input : {};
  const instrumentId = uuid(i['instrumentId'], '/instrumentId');
  const since = i['receivedSince'] === undefined ? null : instant(i['receivedSince'], '/receivedSince');
  const limit = i['limit'] === undefined ? DEFAULT_PAGE : i['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw bad('/limit');
  let after: string | null = i['cursor'] === undefined ? null : afterOf(i['cursor']);
  const rc = rcOf(c), cache = new Map<string, boolean>(), out: Obj[] = [];
  // ponytail: scans at most SCAN_BATCHES x SCAN_BATCH candidate specimens per call (the outbound map is a catalog call, not a SQL filter); a page may come back short with a cursor
  for (let n = 0; n < SCAN_BATCHES && out.length <= limit; n++) {
    const specs = await query(rc, `SELECT s.id, s.barcode, s.priority, s.patient_sex, s.patient_age_days FROM lab.specimens s
        WHERE s.tenant_id = $1 AND s.status IN ('received','aliquoted','in_process') AND ($2::timestamptz IS NULL OR s.received_at >= $2::timestamptz) AND ($3::uuid IS NULL OR s.id > $3::uuid)
          AND EXISTS (SELECT 1 FROM lab.results r WHERE r.tenant_id = s.tenant_id AND r.specimen_id = s.id AND r.status = 'pending')
        ORDER BY s.id LIMIT $4`, [since, after, SCAN_BATCH]);
    if (specs.length === 0) break;
    const pend = await query(rc, `SELECT specimen_id, order_item_id, test_id, analyte_id FROM lab.results WHERE tenant_id = $1 AND specimen_id = ANY($2::uuid[]) AND status = 'pending' ORDER BY order_item_id, analyte_id`, [specs.map((s) => s['id'])]);
    await mapped(c, instrumentId, pend.map((r) => r['analyte_id']), cache);
    for (const s of specs) {
      after = s['id'];
      const tests = testsOf(pend.filter((r) => r['specimen_id'] === s['id']), cache);
      if (tests.length > 0) out.push({ specimenId: s['id'], barcode: s['barcode'], priority: s['priority'], patient: patientOf(s), tests });
      if (out.length > limit) break;
    }
    if (specs.length < SCAN_BATCH) break;
  }
  const items = out.slice(0, limit);
  return { items, ...(out.length > limit ? { nextCursor: cursorOf(items[items.length - 1]!['specimenId']) } : {}) };
}

// ====================================================================================================================================== ingest, hold, module submission
async function ingestInstrumentResult(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, ['device', 'system', 'user']);   // C7 ingest (device) / replay and re-match from the C7 UI (user) / bulk consumer (system)
  const i = isObj(input) ? input : {};
  for (const k of ['instrumentMessageId', 'instrumentId', 'agentId', 'centreId']) uuid(i[k], `/${k}`);
  for (const k of ['analyteId', 'testId']) if (i[k] !== undefined) uuid(i[k], `/${k}`);
  instant(i['receivedAt'], '/receivedAt');
  const ictx = Object.assign(labCtx(c), { store: sqlIngestStore(c.actor.id, resultSideStore(c)), config: { autoverifyHookEnabled: loadLabConfig().autoverifyHookEnabled } });
  const r = await runIngest(ictx, i as never);
  return { outcome: r.outcome, ...(r.resultId === undefined ? {} : { resultId: r.resultId }), ...(r.specimenId === undefined ? {} : { specimenId: r.specimenId }), ...(r.reasonCode === undefined ? {} : { reasonCode: r.reasonCode }) };
}

async function holdResultsSince(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, ['system']);   // C9 QC consumer (01 §2.5)
  return { ...(await runHold(rcOf(c), input)) };
}

async function submitModuleResult(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, STAFF);
  return { ...(await runModuleSubmit(c, input)) };
}

// ====================================================================================================================================== processing state, lookup, history
async function getOrderItemProcessingState(ctx: unknown, input: unknown): Promise<Obj[]> {
  const c = portCtx(ctx, STAFF);
  const orderId = uuid(isObj(input) ? input['orderId'] : undefined, '/orderId');
  if (c.actor.type === 'user') {   // frontdesk.order.read OR frontdesk.order.edit
    try { await c.ports.IdentityPort.assertRole(c, { permission: 'frontdesk.order.read' }); }
    catch (e) { if ((e as { code?: unknown } | null)?.code !== 'auth.forbidden') throw e; await c.ports.IdentityPort.assertRole(c, { permission: 'frontdesk.order.edit' }); }
  }
  const rc = rcOf(c);
  if (!(await first(rc, 'SELECT 1 AS ok FROM lab.orders WHERE tenant_id = $1 AND id = $2', [orderId]))) throw new LimsError('common.not_found');
  // per item (08 A13 D-5, A17.2): received = a NON-rejected specimen of the item has received_at; entered = a non-cancelled result is resulted or later (cancelled rows never count)
  const rows = await query(rc, `SELECT ot.order_item_id,
        bool_and(ot.status = 'cancelled') AS all_cancelled,
        bool_or(ot.status <> 'cancelled') AND bool_and(ot.status = 'cancelled' OR ot.reported_at IS NOT NULL) AS all_reported,
        EXISTS (SELECT 1 FROM lab.order_tests t JOIN lab.specimens s ON s.tenant_id = t.tenant_id AND s.id = t.specimen_id
                WHERE t.tenant_id = ot.tenant_id AND t.order_item_id = ot.order_item_id AND s.status <> 'rejected' AND s.received_at IS NOT NULL) AS received,
        EXISTS (SELECT 1 FROM lab.results r WHERE r.tenant_id = ot.tenant_id AND r.order_item_id = ot.order_item_id AND r.status IN ('resulted','verified','approved')) AS entered
      FROM lab.order_tests ot WHERE ot.tenant_id = $1 AND ot.order_id = $2 GROUP BY ot.tenant_id, ot.order_item_id ORDER BY ot.order_item_id`, [orderId]);
  return rows.map((r) => ({
    orderItemId: r['order_item_id'], removable: !r['received'] && !r['entered'],
    ...(r['received'] ? { reasonCode: 'specimen_received' } : r['entered'] ? { reasonCode: 'result_entered' } : {}),   // [CONV] precedence when both apply (08 A17.2)
    processingStatus: r['all_cancelled'] ? 'cancelled' : r['all_reported'] ? 'reported' : !r['received'] && !r['entered'] ? 'not_started' : 'in_progress',
  }));
}

const refOf = (s: Obj): Obj => {
  const o: Obj = { specimenId: s['id'], barcode: s['barcode'], orderId: s['order_id'], patientId: s['patient_id'], centreId: s['centre_id'] };
  put(o, 'processingCentreId', s['processing_centre_id']);
  o['specimenTypeCode'] = s['specimen_type_code'];
  put(o, 'containerCode', s['container_code']);
  o['status'] = s['status']; o['isActive'] = s['is_active'] === true;
  put(o, 'replacesSpecimenId', s['replaces_specimen_id']); put(o, 'parentSpecimenId', s['parent_specimen_id']);
  o['version'] = Number(s['version']);
  return o;
};

async function lookupSpecimens(ctx: unknown, input: unknown): Promise<Obj[]> {
  const c = portCtx(ctx, STAFF);   // device: refused
  const i = isObj(input) ? input : {};
  const form = [i['barcode'], i['specimenIds'], i['orderId']].filter((v) => v !== undefined).length;
  if (form !== 1) throw bad('/barcode', '/specimenIds', '/orderId');   // exactly one selector
  const orderForm = i['orderId'] !== undefined;
  if (c.actor.type === 'user') {   // lab.specimen.read; the {orderId} form also with homecollection.visit.read (C17 checks the assignment)
    try { await c.ports.IdentityPort.assertRole(c, { permission: 'lab.specimen.read' }); }
    catch (e) { if ((e as { code?: unknown } | null)?.code !== 'auth.forbidden' || !orderForm) throw e; await c.ports.IdentityPort.assertRole(c, { permission: 'homecollection.visit.read' }); }
  }
  const rc = rcOf(c);
  let rows: Obj[];
  if (i['barcode'] !== undefined) rows = await query(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND barcode = $2', [barcodeOf(i['barcode'])]);   // an old barcode resolves only to the old specimen
  else if (i['specimenIds'] !== undefined) {
    const ids = i['specimenIds'];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) throw bad('/specimenIds');
    rows = await query(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [[...new Set(ids.map((x, n) => uuid(x, `/specimenIds/${n}`)))]]);
  } else {
    const st = i['statuses'];
    if (st !== undefined && (!Array.isArray(st) || st.length > SPECIMEN_STATUSES.length || !st.every((x) => typeof x === 'string' && SPECIMEN_STATUSES.includes(x)))) throw bad('/statuses');
    rows = await query(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND order_id = $2 AND ($3::text[] IS NULL OR status = ANY($3)) ORDER BY created_at, id', [uuid(i['orderId'], '/orderId'), st ?? null]);
  }
  return rows.map(refOf);   // unknown / invisible rows are simply absent
}

async function getAnalyteHistory(ctx: unknown, input: unknown): Promise<Obj> {
  const c = portCtx(ctx, STAFF);
  const i = isObj(input) ? input : {};
  const patientId = uuid(i['patientId'], '/patientId'), before = instant(i['before'], '/before');
  const since = i['since'] === undefined ? null : instant(i['since'], '/since');
  const ids = i['analyteIds'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ANALYTES) throw bad('/analyteIds');
  const analyteIds = [...new Set(ids.map((x, n) => uuid(x, `/analyteIds/${n}`)))];
  const limit = i['limitPerAnalyte'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) throw bad('/limitPerAnalyte');
  const exclude = i['excludeOrderId'] === undefined ? null : uuid(i['excludeOrderId'], '/excludeOrderId');
  if (i['includeLegacy'] !== undefined && typeof i['includeLegacy'] !== 'boolean') throw bad('/includeLegacy');   // legacy points: C18 (DEFER B4), none yet
  if (c.actor.type === 'user') await need(c, 'lab.result.read');
  // latest approved version per result, approvedAt in [since, before), newest first, `limit` per analyte (lateral: the history index serves each analyte)
  const rows = await query(rcOf(c), `SELECT a.analyte_id AS series_analyte, p.* FROM unnest($2::uuid[]) AS a(analyte_id) CROSS JOIN LATERAL (
        SELECT c.id, c.order_id, c.current_version_no, c.cur_approved_at, c.cur_value_numeric, c.cur_unit_code, c.cur_flag FROM lab.v_result_current c
        WHERE c.tenant_id = $1 AND c.patient_id = $3 AND c.analyte_id = a.analyte_id AND c.status = 'approved' AND c.cur_approved_at < $4::timestamptz
          AND ($5::timestamptz IS NULL OR c.cur_approved_at >= $5::timestamptz) AND ($6::uuid IS NULL OR c.order_id <> $6::uuid)
        ORDER BY c.cur_approved_at DESC, c.id LIMIT $7) p`, [analyteIds, patientId, before, since, exclude, limit]);
  return {
    series: analyteIds.map((analyteId) => ({
      analyteId,
      points: rows.filter((r) => r['series_analyte'] === analyteId).sort((x, y) => new Date(y['cur_approved_at']).getTime() - new Date(x['cur_approved_at']).getTime()).map((r) => {
        const p: Obj = { source: 'lis', resultId: r['id'], orderId: r['order_id'], versionNo: Number(r['current_version_no']), approvedAt: iso(r['cur_approved_at']) };
        put(p, 'valueNumeric', r['cur_value_numeric']); put(p, 'unitCode', r['cur_unit_code']); put(p, 'flag', r['cur_flag']);
        return p;
      }),
    })),
  };
}
export const labPort = {
  getOrderResults, getPendingTestsForBarcode, ingestInstrumentResult, holdResultsSince, submitModuleResult, getOrderItemProcessingState, listPendingForInstrument, lookupSpecimens, getAnalyteHistory,
} as const;
