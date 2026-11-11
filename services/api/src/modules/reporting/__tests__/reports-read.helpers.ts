// C6-T15 test helpers (not a test file). Synthetic data only. Single-table fake DB of the worker tests (consumers.helpers.ts) + ORDER BY/LIMIT (assemble.helpers wrapTx).
// ASSUMED (spec gives no signatures; repeated in .orchestra/notes/C6-T15-tests.md):
//   - R1-R5 handlers take the usual API ctx { tenantId, actor:{type:'user',id,membershipId}, tx, ports, audit:{access}, storage, log, now }
//   - ports: ctx.ports.lab.lookupSpecimens(ctx,{barcode}) (R2) and ctx.ports.IdentityPort.assertRole(ctx,{permission}) (P-10 checks, same shape as R6/R7)
//   - NO port is called for R1/R3/R4/R5 (snapshot columns, review fix #6): every other port method throws in these helpers
//   - the report PDF is read with ctx.storage.read('reports', versions.pdf_object_path) (bucket of the render task)
//   - centre RLS (`__tenant_centre`) is emulated: SELECTs on reporting.* only return rows whose centre_id is in `centres` (the real policy is a DB test of C0/C6-T02)
//   - the fake supports single-table statements only (no JOIN / sub-select / count(*) / LIKE): the implementation must read reports, items, versions, deliveries with separate statements
import { makeDb, idN, TENANT_A, TENANT_B, NOW, SYSTEM_ACTOR, type Row } from '../../../../../worker/src/jobs/reporting/__tests__/consumers.helpers.js';
import { wrapTx, mutex } from '../../../../../worker/src/jobs/reporting/__tests__/assemble.helpers.js';
import { makeStorage } from './outsourced.helpers.js';

export { TENANT_A, TENANT_B, NOW, idN, type Row };
export const USER = idN(0xa001); export const MEMBERSHIP = idN(0x3001);
export const CENTRE_A = idN(0xc1); export const CENTRE_B = idN(0xc2);
export const RID = (i: number) => idN(0x51000 + i);
export const OID = (i: number) => idN(0x52000 + i);
export const PID = (i: number) => idN(0x53000 + i);
export const VID = (i: number, n = 1) => idN(0x54000 + i * 10 + n);
export const REPORTS_BUCKET = 'reports';
export const PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic report v-bytes\n%%EOF');
export const SENTINEL_SNAPSHOT = 'SENTINEL-snapshot-Sita-Karki';          // lives only in content_snapshot (P3): must never be returned
export const SENTINEL_PHONE = '+9779800000099';                           // lives only in deliveries.destination: must never be returned
export const pad = (i: number) => String(i).padStart(6, '0');
export const iso = (day: number, min: number) => new Date(Date.UTC(2026, 10, day, 0, min)).toISOString();

export const REPORT_SUMMARY_KEYS = ['id', 'order_id', 'family', 'centre_id', 'state', 'display_status', 'registration_no', 'patient_display_name', 'centre_code', 'referrer_name',
  'items_total', 'items_ready', 'latest_version_no', 'released_version_no', 'held_basis', 'balance_due_paisa', 'registered_at', 'first_released_at', 'updated_at', 'version'];
export const REPORT_SUMMARY_REQUIRED = ['id', 'order_id', 'family', 'centre_id', 'state', 'display_status', 'registration_no', 'centre_code', 'items_total', 'items_ready', 'registered_at', 'updated_at', 'version'];
export const REPORT_DETAIL_KEYS = [...REPORT_SUMMARY_KEYS, 'items', 'versions', 'deliveries_summary', 'review_flag'];
export const ITEM_KEYS = ['order_item_id', 'test_names', 'item_kind', 'requires_lab', 'requires_narrative', 'requires_outsourced', 'lab_ready', 'narrative_ready', 'outsourced_ready', 'item_status'];
export const VERSION_SUMMARY_KEYS = ['id', 'version_no', 'status', 'report_kind', 'completeness', 'page_count', 'pdf_bytes', 'rendered_at', 'released_at', 'release_basis', 'audiences',
  'supersedes_version_no', 'superseded_at', 'held_basis', 'held_checked_at', 'last_render_error_code', 'version'];
export const VERSION_SUMMARY_REQUIRED = ['id', 'version_no', 'status', 'report_kind', 'completeness', 'version'];
export const DELIVERY_STATES = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'];

/** A reports row with every column of 05-SCHEMA §2.1, incl. the internal ones that must never leave the mapper. `i` makes ids, registration_no and timestamps distinct. */
export const reportRow = (i: number, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A, id: RID(i), branch_id: idN(5), order_id: OID(i), patient_id: PID(i), referrer_id: idN(0xd0c1), partner_id: null, family: 'laboratory',
  order_source: 'front_desk', registered_at: iso(1, i), state: 'open', needs_assembly: false, needs_assembly_since: null, latest_version_no: 0, released_version_no: null,
  lab_ready_seq: 3, lab_approved_set_hash: 'a'.repeat(64), lab_completeness: 'complete', lab_contains_amendment: false, regeneration_counter: 2,
  billing_balance_due_paisa: null, billing_release_eligible: true, billing_balance_version: 1, first_released_at: null, final_released_at: null, review_flag: null, cancelled_at: null,
  registration_no: `0001SY${pad(i)}`, patient_display_name: `Test Patient ${pad(i)}`, centre_code: 'C000000099', referrer_name: 'Dr. Synthetic Referrer',
  created_at: iso(1, i), created_by: SYSTEM_ACTOR, updated_at: iso(2, i), updated_by: SYSTEM_ACTOR, version: 5, ...over });

/** A report_versions row (05-SCHEMA §2.3) incl. the internal columns (content_snapshot P3, hashes, object path, patient_id, ...). */
export const versionRow = (i: number, n = 1, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A, id: VID(i, n), report_id: RID(i), order_id: OID(i), patient_id: PID(i), partner_id: null, version_no: n, status: 'rendered', report_kind: 'final',
  completeness: 'complete', order_item_ids: [idN(0x55000 + i)], content_fingerprint: 'f'.repeat(64), approved_set_hash: 'a'.repeat(64),
  content_snapshot: { schemaVersion: 1, patient: { fullName: SENTINEL_SNAPSHOT } }, content_sha256: 'c'.repeat(64), template_version_id: idN(0x902),
  pdf_object_path: `${TENANT_A}/2026/11/${RID(i)}-v${n}.pdf`, pdf_sha256: 'd'.repeat(64), pdf_bytes: '1000', page_count: 2, render_attempts: 1, last_render_error_code: null,
  rendering_started_at: iso(1, 30), rendered_at: iso(1, 40), released_at: null, released_by: null, release_mode: null, release_basis: null, release_override_id: null, audiences: null,
  supersedes_version_no: null, superseded_at: null, superseded_by_version_no: null, discarded_at: null, discard_reason: null, held_basis: null, held_checked_at: null,
  created_at: iso(1, 35), created_by: SYSTEM_ACTOR, updated_at: iso(1, 40), updated_by: SYSTEM_ACTOR, version: 3, ...over });
export const RELEASED = { status: 'released', released_at: iso(3, 5), released_by: USER, release_mode: 'manual', release_basis: 'paid_in_full', audiences: ['patient', 'centre'], version: 4 } as const;

export const itemRow = (i: number, k: number, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A, id: idN(0x56000 + i * 10 + k), report_id: RID(i), order_id: OID(i), order_item_id: idN(0x55000 + i * 10 + k), orderable_id: idN(0x2000 + k),
  orderable_kind: 'test', test_ids: [idN(0x3000 + k)], narrative_test_ids: [], priority: 'routine', item_status: 'active', requires_lab: true, requires_narrative: false, requires_outsourced: false,
  lab_ready: true, narrative_ready: false, outsourced_ready: false, ready_marker: null, approved_results: 1, amendment_pending: false, specimen_hint: null, specimen_hint_seq: null,
  items_version: 1, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, version: 1, ...over });

export const deliveryRow = (i: number, k: number, status: string, over: Row = {}): Row => ({
  tenant_id: TENANT_A, centre_id: CENTRE_A, id: idN(0x57000 + i * 100 + k), report_id: RID(i), report_version_no: 1, channel: 'sms', purpose: 'report', recipient_kind: 'patient', status,
  destination: SENTINEL_PHONE, template_code: 'report_ready', attempt_no: 1, created_at: iso(3, k), created_by: SYSTEM_ACTOR, ...over });

export interface ReadOpts {
  reports?: Row[]; versions?: Row[]; items?: Row[]; deliveries?: Row[];
  /** centre ids the caller may see (RLS emulation); null/undefined = all centres of the tenant */
  centres?: readonly string[] | null;
  /** lab.lookupSpecimens reply by barcode (omitted barcode => []) */
  specimens?: Record<string, ReadonlyArray<{ orderId: string; centreId?: string }>>;
  /** permissions the caller lacks: assertRole(ctx,{permission}) rejects with auth.forbidden for them */
  denied?: readonly string[];
  pdf?: Record<string, Uint8Array>;                // pdf_object_path -> bytes
}

export function readSetup(o: ReadOpts = {}) {
  const db = makeDb({ 'reporting.reports': o.reports ?? [], 'reporting.report_versions': o.versions ?? [], 'reporting.report_order_items': o.items ?? [], 'reporting.deliveries': o.deliveries ?? [] });
  const base = wrapTx(db.tx, mutex()); const centres = o.centres ? new Set(o.centres) : null;
  const tx: any = {
    startedAt: base.startedAt, savepoint: base.savepoint, release: base.release,
    async query(text: string, values: unknown[] = []) {
      const res = await base.query(text, values);
      // The fake cannot evaluate `to_char(<col> AT TIME ZONE 'UTC', '...US"Z"') AS sort_key` (µs-precision keyset cursor, review C6-T15 #1): emulate it from the stored value.
      const sk = /to_char\(\s*(\w+)\s+at\s+time\s+zone[^)]*\)\s+as\s+sort_key\b/i.exec(text);
      if (sk) res.rows = res.rows.map((r: Row) => ({ ...r, sort_key: typeof r[sk[1]!] === 'string' ? r[sk[1]!] : new Date(r[sk[1]!] as any).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') }));
      if (centres && /^\s*select/i.test(text) && /\breporting\./i.test(text)) return { rows: res.rows.filter((r: Row) => r['centre_id'] === undefined || centres.has(r['centre_id'])) };
      return res;
    },
  };
  const storage = makeStorage();
  for (const [p, b] of Object.entries(o.pdf ?? {})) storage.objects.set(`${REPORTS_BUCKET}::${p}`, b);
  const access: any[] = []; const roleCalls: any[] = []; const lookups: any[] = []; const portCalls: string[] = []; const logs: unknown[] = [];
  const refuse = (name: string) => async () => { portCalls.push(name); throw new Error(`unexpected port call ${name}`); };
  const ports: any = {
    lab: { async lookupSpecimens(_c: unknown, input: any) { lookups.push(input); portCalls.push('lab.lookupSpecimens'); return (o.specimens?.[input.barcode] ?? []).map((s) => ({ specimenId: idN(0x58000), barcode: input.barcode, orderId: s.orderId, patientId: idN(1), centreId: s.centreId ?? CENTRE_A, status: 'received', isActive: true, version: 1 })); },
      getOrderResults: refuse('lab.getOrderResults') },
    frontdesk: { getOrderSummary: refuse('frontdesk.getOrderSummary'), getPatientDemographics: refuse('frontdesk.getPatientDemographics') },
    catalog: { getTest: refuse('catalog.getTest'), getReferrer: refuse('catalog.getReferrer'), getPanel: refuse('catalog.getPanel') },
    billing: { getReleaseEligibility: refuse('billing.getReleaseEligibility') },
    IdentityPort: { async assertRole(_c: unknown, req: any) { roleCalls.push(req); if (o.denied?.includes(req.permission)) throw Object.assign(new Error('forbidden'), { code: 'auth.forbidden' }); } },
  };
  const sink = (x: unknown) => { logs.push(x); };
  const ctx = (over: Row = {}): any => ({ tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, requestId: idN(0xf1), operationId: 'x', clientIp: '203.0.113.9',
    tx, ports, storage: storage.forTenant(TENANT_A), audit: { access: async (e: any) => { access.push(structuredClone(e)); } }, now: () => NOW,
    log: { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } }, ...over });
  return { db, tx, ports, storage, access, roleCalls, lookups, portCalls, logs, ctx, stmtText: () => db.stmts.map((s) => s.text).join('\n'),
    allText: (extra: unknown = {}) => JSON.stringify({ a: access, l: logs, r: roleCalls, e: extra }) };
}
export type ReadSetup = ReturnType<typeof readSetup>;

export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const lower = (h: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
/** No `null` anywhere in a JSON body (02-CV §4: absent, never null). */
export const hasNull = (v: unknown): boolean => v === null || (Array.isArray(v) ? v.some(hasNull) : typeof v === 'object' && v !== undefined ? Object.values(v as object).some(hasNull) : false);
