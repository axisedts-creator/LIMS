// C5 T-24 real-implementation harness for packages/fakes/contract-tests/LabPort.contract.ts (not a test file).
// The REAL `labPort` (ports/LabPort.impl.ts) is driven the way another module calls it: a STRICT RequestContext { tenantId, actor, requestId, tx, now(): IsoUtc, ports } — no ctx.events / ctx.store /
// ctx.audit / ctx.log — over a REAL PG17 transaction as role lims_api with RLS on. One port call = one transaction (BEGIN, claims, call, COMMIT; ROLLBACK + error on throw), like FrontdeskPort's harness.
// Needs the migrated+seeded database of tests/db/c5-t03/run.sh (LIMS_TEST_DATABASE_URL = lims_api, LIMS_TEST_ADMIN_DATABASE_URL = superuser). Without them `live` is false and the DB suites skip,
// except under LIMS_T03_REQUIRE_DB=1 where the "database is provided" test fails.
// ASSUMED seams (writer: dispute via .orchestra/notes if wrong; the spec fixes behaviour, not names):
//   ../LabPort.impl.ts   export const labPort  — the manifest object with the ten LabPortV1 methods (03-IC §4.5 + 08 §4.14), each `(ctx, input)`; also registered as `manifest.ports.LabPort` in ../../index.ts.
//   Every method runs in ctx.tx (no transaction of its own), reads the tenant from ctx.tenantId only (REQ-SEC-024), publishes events through the lab event publisher over ctx.tx (events/publish.ts -> core.event_log),
//   and uses ctx.now() (an ISO string). It sees these ports (ctx.ports): IdentityPort { assertRole(ctx, { permission, centreId? }) — passes iff the ACTOR holds the permission; SYSTEM ACTORS PASS (they have no grants
//   in this fake, the impl must still apply its own actor-type guards), getTenantSettings }, CatalogPort { mapInstrumentCode (inbound by instrumentCode, outbound by analyteId), referenceRangeFor, criticalLimitsFor }.
//   No QualityPort / FrontdeskPort is provided: the impl must work without them for the contract cases (auto-verify hook is off).
// SEEDING: `seed(fixtures)` maps the contract fixtures ({ orders, items, specimens, results, mappings, criticalLimits, qcHolds, grants }) onto frontdesk.* parents + lab.* rows (superuser, claims of the system actor so the
//   audit triggers have a context). Seeding is additive; `makeImpl()` first removes every row of the test id namespace (and every row the impl created for those orders: versions, approvals, verifications, holds,
//   ingest log/exceptions, module submissions, critical log, event_log) with session_replication_role = replica, so each case starts clean. Frontdesk parents / centres / patients are left in place (idempotent).
// ID / BARCODE ADAPTERS (the shared suite is implementation-agnostic, the real schema is not):
//   - specimens.barcode CHECK is ^[A-Z0-9]{1,20}$ but the suite uses 'SYN-0001': the harness stores the barcode without '-' and maps `barcode` / `sampleBarcode` of every input and `barcode` of every output back and forth.
//   - core.collection_centres rows are created for every centre id a fixture names (branch a101 / b101 of tenant A / B). Tenant A / B of ctxFor are the seeded tenants a001 / b001.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';

export const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
export const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
export const live = Boolean(API_URL && ADMIN_URL);
export const requireDb = process.env['LIMS_T03_REQUIRE_DB'] === '1';

export const TENANT = { A: '01a1a98a-ac40-7000-8000-00000000a001', B: '01a1a98a-ac40-7000-8000-00000000b001' } as const;
export const BRANCH = { A: '01a1a98a-ac40-7000-8000-00000000a101', B: '01a1a98a-ac40-7000-8000-00000000b101' } as const;
export const MEMBERSHIP = { A: '01a1a98a-ac40-7000-8000-00000000a500', B: '01a1a98a-ac40-7000-8000-00000000b500' } as const;
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const NOW = '2026-11-05T04:15:00.000Z';
/** every id this harness owns starts with this (contract ids L(n) and the local ids); the perf suite owns PERF_NS */
export const NS = '01900000-0000-7000-8000-00000000c';
export const PERF_NS = '01900000-0000-7000-8000-d';   // tail 'd' + 11 digits: never matches NS (tail '00000000c…')
export const L = (n: number): string => `01900000-0000-7000-8000-${(0xc000 + n).toString(16).padStart(12, '0')}`;
export const tenantKey =(tenantId: string): 'A' | 'B' => (tenantId === TENANT.B ? 'B' : 'A');
type Obj = Record<string, any>;

let apiPool: pg.Pool | undefined, adminPool: pg.Pool | undefined;
export const api = (): pg.Pool => (apiPool ??= new pg.Pool({ connectionString: API_URL, max: 12 }));
export const admin = (): pg.Pool => (adminPool ??= new pg.Pool({ connectionString: ADMIN_URL, max: 4 }));
export async function closePools(): Promise<void> { await Promise.all([apiPool?.end(), adminPool?.end()]); apiPool = adminPool = undefined; }
/** owner-side truth (RLS bypassed) */
export const q = async (text: string, values: unknown[] = []): Promise<any[]> => (await admin().query(text, values)).rows;

export const claimsOf = (tenantId: string, sub: string, actorType: string, extra: Obj = {}): string => JSON.stringify({ tenant_id: tenantId, sub, actor_type: actorType, ...extra });

// ------------------------------------------------------------------ admin writes
const colsCache = new Map<string, Set<string>>();
async function ins(c: pg.PoolClient, table: string, row: Obj): Promise<void> {
  if (!colsCache.has(table)) {
    const [s, t] = table.split('.');
    colsCache.set(table, new Set((await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [s, t])).rows.map((r) => r.column_name)));
  }
  const cols = colsCache.get(table)!;
  const r: Obj = { ...row };
  for (const a of ['created_by', 'updated_by']) if (cols.has(a) && !(a in r)) r[a] = SYS;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  if (r['tenant_id']) await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsOf(r['tenant_id'], SYS, 'system')]);
  const keys = Object.keys(r);
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
    keys.map((k) => (r[k] !== null && typeof r[k] === 'object' && !Array.isArray(r[k]) && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k])));
  // ON CONFLICT DO NOTHING hides a stale/other-tenant frontdesk parent (cleanup() keeps them): fail loudly instead of an FK error later (ruling C5.T-24 #2 item 3)
  if (table.startsWith('frontdesk.') && r['id'] && r['tenant_id']) {
    const got = await c.query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [r['id'], r['tenant_id']]);
    if (!got.rowCount) throw new Error(`harness: ${table} id ${String(r['id'])} already exists with a different tenant/parent; use fixture ids unique to the describe`);
  }
}
export async function asAdmin<T>(fn: (c: pg.PoolClient) => Promise<T>, replica = false): Promise<T> {
  const c = await admin().connect();
  try {
    await c.query('BEGIN');
    if (replica) await c.query('SET LOCAL session_replication_role = replica');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

/** app.enqueue_job rejects identifiers absent from core.g_task_registry (C0 02-TRD:867); the deploy-time registry-sync (02-TRD:790) fills it, app code never does (ruling C5.T-24 #2). Superuser, idempotent. */
export async function ensureTaskRegistry(): Promise<void> {
  await asAdmin(async (c) => { await c.query(
    `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',25) ON CONFLICT DO NOTHING`); });
}

/** Removes every row of the id namespace `ns` (+ everything the impl created for those orders). Frontdesk parents stay. */
export async function cleanup(ns: string): Promise<void> {
  const like = `${ns}%`;
  await asAdmin(async (c) => {
    const orders = `(SELECT id FROM lab.orders WHERE id::text LIKE $1)`;
    const results = `(SELECT id FROM lab.results WHERE order_id IN ${orders})`;
    const stmts: string[] = [
      `DELETE FROM lab.critical_notifications WHERE critical_event_id IN (SELECT id FROM lab.critical_value_log WHERE order_id IN ${orders})`,
      `DELETE FROM lab.critical_value_log WHERE order_id IN ${orders}`,
      ...['result_attachments', 'result_observations', 'result_versions', 'verifications', 'approvals', 'module_submissions'].map((t) => `DELETE FROM lab.${t} WHERE result_id IN ${results}`),
      `DELETE FROM lab.ingest_log WHERE centre_id::text LIKE $1 OR specimen_id IN (SELECT id FROM lab.specimens WHERE order_id IN ${orders})`,
      `DELETE FROM lab.ingest_exceptions WHERE centre_id::text LIKE $1`,
      `DELETE FROM lab.qc_holds WHERE instrument_id::text LIKE $1 OR qc_run_id::text LIKE $1`,
      `DELETE FROM lab.order_readiness WHERE order_id IN ${orders}`,
      `DELETE FROM lab.report_releases WHERE order_id IN ${orders}`,
      `DELETE FROM lab.worksheet_items WHERE order_test_id IN (SELECT id FROM lab.order_tests WHERE order_id IN ${orders})`,
      `DELETE FROM lab.specimen_transitions WHERE specimen_id IN (SELECT id FROM lab.specimens WHERE order_id IN ${orders})`,
      `DELETE FROM lab.results WHERE order_id IN ${orders}`,
      `DELETE FROM lab.order_tests WHERE order_id IN ${orders}`,
      `DELETE FROM lab.specimens WHERE order_id IN ${orders}`,
      `DELETE FROM lab.orders WHERE id::text LIKE $1`,
      `DELETE FROM core.event_log WHERE envelope::text LIKE '%' || $1 || '%'`,
    ];
    for (const s of stmts) await c.query(s, [s.includes('event_log') ? ns : like]);
  }, true);
}

// ------------------------------------------------------------------ fixtures -> rows
const tail = (id: string) => id.slice(-4);
/** order-test id derived from the item id (same namespace, 0xc1xx / 0xd1xx) */
export const orderTestIdOf = (itemId: string): string => itemId.replace(/-(0{8})([cd])0(..)$/, (_m, z, n, t) => `-${z}${n}1${t}`);
const RESULT_RANK: Record<string, number> = { pending: 0, resulted: 1, verified: 2, approved: 3 };
export const dropDash =(s: string) => s.replace(/-/g, '');

export interface World { barcodes: Map<string, string>; mappings: Obj[]; criticalLimits: Obj[]; grants: Record<string, string[]> }

export async function seedFixtures(w: World, f: Obj): Promise<void> {
  if ((f.qcHolds ?? []).length) throw new Error('harness: fixtures.qcHolds are not mapped; seed holds through holdResultsSince');
  Object.assign(w.grants, f.grants ?? {});
  w.mappings.push(...(f.mappings ?? []));
  w.criticalLimits.push(...(f.criticalLimits ?? []));
  const orders: Obj[] = f.orders ?? [], items: Obj[] = f.items ?? [], specimens: Obj[] = f.specimens ?? [], results: Obj[] = f.results ?? [];
  const allOrders = new Map<string, Obj>(orders.map((o) => [o.id, o]));
  const itemById = new Map<string, Obj>(items.map((i) => [i.id, i]));

  await asAdmin(async (c) => {
    // --- centres, patients, frontdesk parents
    const centres = new Map<string, string>();
    for (const o of orders) centres.set(o.centreId, o.tenantId);
    for (const s of specimens) if (s.processingCentreId) centres.set(s.processingCentreId, s.tenantId);
    for (const [centreId, tenantId] of centres) {
      await ins(c, 'core.collection_centres', { id: centreId, tenant_id: tenantId, branch_id: BRANCH[tenantKey(tenantId)], centre_code: `C5T${tail(centreId)}`.toUpperCase(), name: `Synthetic centre ${tail(centreId)}`, centre_kind: 'own' });
    }
    for (const o of orders) {
      await ins(c, 'frontdesk.patients', { id: o.patientId, tenant_id: o.tenantId, patient_code: `P-${tail(o.patientId)}`.toUpperCase(), full_name: `Synthetic Patient ${tail(o.patientId)}`,
        name_search: `synthetic patient ${tail(o.patientId)}`, sex: o.patient?.sex ?? 'female', registered_centre_id: o.centreId });
      await ins(c, 'frontdesk.orders', { id: o.id, tenant_id: o.tenantId, branch_id: BRANCH[tenantKey(o.tenantId)], centre_id: o.centreId, patient_id: o.patientId, registration_no: `R-T24-${tail(o.id)}`, status: 'registered',
        visit_type: 'opd', billing_mode: 'cash', priority: o.priority ?? 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: NOW });
    }
    for (const it of items) {
      const o = allOrders.get(it.orderId)!;
      await ins(c, 'frontdesk.order_items', { id: it.id, tenant_id: it.tenantId, order_id: it.orderId, centre_id: o.centreId, orderable_id: it.testId, orderable_kind: 'test', code: `T${tail(it.testId)}`.toUpperCase(),
        name: `Synthetic test ${tail(it.testId)}`, test_ids: [it.testId], priority: 'routine', unit_price_paisa: 1000, price_list_id: L(250), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
    }
    // --- lab.orders, lab.lab_settings
    for (const o of orders) {
      await ins(c, 'lab.orders', { id: o.id, tenant_id: o.tenantId, centre_id: o.centreId, branch_id: BRANCH[tenantKey(o.tenantId)], patient_id: o.patientId, registration_no: `R-T24-${tail(o.id)}`, visit_type: 'opd',
        priority: o.priority ?? 'routine', source: 'front_desk', registered_at: NOW, patient_sex: o.patient?.sex ?? 'female', patient_age_days: o.patient?.ageDays ?? null, last_order_seq: 1 });
    }
    for (const t of new Set(orders.map((o) => o.tenantId))) await ins(c, 'lab.lab_settings', { tenant_id: t });
    // amendment reasons are "seeded by db/seeds" (05-SCHEMA §8) but no lab seed file exists yet: the harness seeds the codes the cases use (global coded set, idempotent)
    for (const [n, code] of ['correction', 'module_phase_progression', 'module_preliminary_update', 'supplementary_report'].entries()) {
      await ins(c, 'lab.g_cs_amendment_reasons', { id: L(0xf0 + n), code, display: code.replace(/_/g, ' '), sort_order: n });
    }
    // --- specimens (a replacement after the specimen it replaces)
    const orderOfSpec = (s: Obj) => allOrders.get(s.orderId)!;
    for (const s of [...specimens].sort((a, b) => Number(Boolean(a.replacesSpecimenId)) - Number(Boolean(b.replacesSpecimenId)))) {
      const o = orderOfSpec(s);
      const stored = dropDash(s.barcode);
      w.barcodes.set(stored, s.barcode);
      const received = Boolean(s.receivedAt) || ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved'].includes(s.status);
      await ins(c, 'lab.specimens', { id: s.id, tenant_id: s.tenantId, centre_id: o.centreId, ...(received ? { processing_centre_id: s.processingCentreId ?? o.centreId, processing_branch_id: BRANCH[tenantKey(s.tenantId)] } : {}),
        order_id: s.orderId, patient_id: o.patientId, barcode: stored, creation_key: `ck-${s.id}`, specimen_type_code: s.specimenTypeCode ?? 'BLOOD', priority: o.priority ?? 'routine', patient_sex: o.patient?.sex ?? 'female',
        patient_age_days: o.patient?.ageDays ?? null, status: s.status, replaces_specimen_id: s.replacesSpecimenId ?? null, ordered_at: NOW,
        ...(received ? { received_at: s.receivedAt ?? '2026-11-05T02:00:00.000Z' } : {}),
        ...(s.status === 'rejected' ? { rejected_at: NOW, rejection_reason_code: 'hemolysed' } : {}), is_active: s.isActive ?? s.status !== 'rejected', version: s.version ?? 1 });
    }
    // --- order tests (one per item) and results
    const specOfItem = (itemId: string): Obj | undefined => {
      const mine = specimens.filter((s) => (s.itemIds ?? []).includes(itemId));
      return mine.find((s) => s.status !== 'rejected') ?? mine[0];
    };
    for (const it of items) {
      const o = allOrders.get(it.orderId)!;
      const spec = specOfItem(it.id);
      const mine = results.filter((r) => r.orderItemId === it.id);
      const live = mine.filter((r) => r.status !== 'cancelled');
      const specRejected = spec?.status === 'rejected';
      const specReceived = spec ? ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved'].includes(spec.status) : false;
      const rank = live.length ? Math.min(...live.map((r) => RESULT_RANK[r.status] ?? 0)) : -1;
      const best = live.length ? Math.max(...live.map((r) => RESULT_RANK[r.status] ?? 0)) : -1;
      let status: string;
      if (mine.length && !live.length && specRejected) status = 'cancelled';
      else if (it.reportedAt) status = 'approved';
      else if (live.length && rank === 3) status = 'approved';
      else if (best >= 2) status = best === 3 ? 'resulted' : 'verified';
      else if (best === 1) status = 'resulted';
      else status = specReceived ? 'in_process' : spec ? 'awaiting_receipt' : 'awaiting_receipt';
      await ins(c, 'lab.order_tests', { id: orderTestIdOf(it.id), tenant_id: it.tenantId, centre_id: o.centreId, ...(specReceived ? { processing_centre_id: o.centreId, processing_branch_id: BRANCH[tenantKey(it.tenantId)] } : {}),
        order_id: it.orderId, order_item_id: it.id, test_id: it.testId, test_code: `T${tail(it.testId)}`.toUpperCase(), test_revision: 1, catalog_revision: 1, department_id: it.departmentId, workflow_type: it.workflowType ?? 'standard',
        priority: o.priority ?? 'routine', specimen_id: spec?.id ?? null, uses_existing_material: !spec || Boolean(it.usesExistingMaterial), status, ordered_at: NOW,
        ...(it.reportedAt ? { reported_at: it.reportedAt } : {}), ...(specReceived ? { received_at: spec!.receivedAt ?? '2026-11-05T02:00:00.000Z' } : {}),
        ...(status === 'cancelled' ? { cancelled_at: NOW, cancel_reason: 'specimen_rejected' } : {}) });
    }
    for (const r of results) {
      const it = itemById.get(r.orderItemId)!;
      const o = allOrders.get(it.orderId)!;
      const spec = specOfItem(it.id);
      const specReceived = spec ? ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved'].includes(spec.status) : false;
      const valued = ['resulted', 'verified', 'approved'].includes(r.status);
      const resultedAt = r.resultedAt ?? r.approvedAt ?? r.verifiedAt ?? NOW;
      const mod = r.moduleRef;
      await ins(c, 'lab.results', { id: r.id, tenant_id: r.tenantId, centre_id: o.centreId, ...(specReceived ? { processing_centre_id: o.centreId, processing_branch_id: BRANCH[tenantKey(r.tenantId)] } : {}),
        order_id: it.orderId, order_item_id: it.id, order_test_id: orderTestIdOf(it.id), specimen_id: spec?.id ?? null, patient_id: o.patientId, test_id: r.testId, analyte_id: r.analyteId, analyte_code: `AN${tail(r.analyteId)}`,
        department_id: it.departmentId, is_reportable: r.isReportable ?? true, result_type: mod ? 'narrative' : 'numeric', status: r.status,
        origin: valued ? (r.origin ?? 'manual') : null, value_numeric: valued ? (r.valueNumeric ?? null) : null, instrument_id: r.instrumentId ?? null,
        ...(valued ? { resulted_at: resultedAt, first_resulted_at: resultedAt } : {}),
        ...(['verified', 'approved'].includes(r.status) && r.verifiedAt ? { verified_at: r.verifiedAt, verified_by_membership_id: r.verifiedByMembershipId ?? MEMBERSHIP[tenantKey(r.tenantId)] } : {}),
        ...(r.status === 'approved' ? { approved_at: r.approvedAt ?? resultedAt, approved_by_membership_id: MEMBERSHIP[tenantKey(r.tenantId)] } : {}),
        ...(r.status === 'cancelled' ? { cancelled_at: NOW, cancel_reason: 'specimen_rejected' } : {}),
        on_hold: r.onHold ?? false, qc_review_required: r.qcReviewRequired ?? false, comment_codes: r.commentCodes ?? [], current_version_no: r.versionNo ?? 1,
        ...(mod ? { module_payload_module: mod.module, module_payload_entity_id: mod.entityId, module_payload_version_no: r.lastPayloadVersion ?? mod.versionNo, module_report_phase: r.lastPhase ?? 'final', module_summary_text: r.summaryText ?? 'Synthetic summary' } : {}) });
      if (r.status === 'approved') {
        const n = r.versionNo ?? 1;
        for (let v = 1; v <= n; v++) {
          await ins(c, 'lab.result_versions', { id: randomUUID(), tenant_id: r.tenantId, centre_id: o.centreId, result_id: r.id, version_no: v, origin: r.origin ?? 'manual',
            value_numeric: v === n ? (r.valueNumeric ?? null) : (r.priorValues?.[v - 1] ?? '1.00'), is_critical: false, approved_at: r.approvedAt ?? resultedAt, approved_by_membership_id: MEMBERSHIP[tenantKey(r.tenantId)],
            ...(v > 1 ? { previous_version_no: v - 1, amendment_reason_code: 'correction' } : {}), ...(v < n ? { superseded_at: NOW, superseded_by_version_no: v + 1 } : {}),
            ...(mod ? { module_payload_module: mod.module, module_payload_entity_id: mod.entityId, module_payload_version_no: r.lastPayloadVersion ?? mod.versionNo, module_report_phase: r.lastPhase ?? 'final' } : {}) });
          await ins(c, 'lab.approvals', { id: randomUUID(), tenant_id: r.tenantId, centre_id: o.centreId, result_id: r.id, version_no: v, kind: v === 1 ? 'approval' : 'amendment', membership_id: MEMBERSHIP[tenantKey(r.tenantId)], aal: 'aal2', occurred_at: NOW });
        }
      }
    }
  });
}
