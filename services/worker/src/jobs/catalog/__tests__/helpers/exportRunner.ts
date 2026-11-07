// T-24 (C3) test helper: JobContext runner + synthetic catalog seed for the worker task catalog.export_build (02-TRD §8.7, §10).
// DB fake: services/api/.../helpers/exportsDb.ts (dialect documented there). ctx.tx is the task transaction — COMMITTED when the handler
// resolves, ROLLED BACK when it throws (as the worker core does). ctx.db.tx(fn) is fn(ctx): the SAME transaction (consumer.ts:58), so a write
// made before a rethrow is rolled back too; a `failed` state can only persist if the handler RESOLVES (final-attempt hook = CR-pending).
// Synthetic data only.
import { makeExportsDb, NOW, TENANT_A, TENANT_B, USER, V7, type ExportsDb, type Row } from '../../../../../../api/src/modules/catalog/__tests__/helpers/exportsDb.js';

export { makeExportsDb, NOW, TENANT_A, TENANT_B, USER, V7 };
export type { ExportsDb };
export const SYS = '0190a000-0000-7000-8000-0000000a0004';           // catalog system actor (shape only)
export const uid = (n: number) => `0190c322-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const DAY = 86_400_000;

export function makeLog() {
  const lines: string[] = [];
  const safe = (v: unknown) => { try { return JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : typeof x === 'bigint' ? String(x) : x)); } catch { return String(v); } };
  const log: any = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args: unknown[]) => { lines.push(`${level} ${safe(args)}`); };
  log.child = () => log;
  return { log, lines, text: () => lines.join('\n') };
}

export function makeRunner(db: ExportsDb, handler: (payload: any, ctx: any) => Promise<void>, o: { tenantId?: string; attempt?: number; maxAttempts?: number } = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const events: unknown[] = [];
  const metrics: Array<{ name: string; labels: any }> = [];
  const l = makeLog();
  const build = (tx: any, attempt: number, maxAttempts: number): any => {
    const ctx: any = {
      tenantId, actor: { type: 'system', id: SYS }, requestId: uid(9000), tx: tx.facade, attempt, maxAttempts, jobId: '1', now: () => NOW, isNewer: () => true,
      events: { publish: async (...a: unknown[]) => { events.push(a); } }, core: {}, storage: {}, audit: {}, files: {}, log: l.log,
      metrics: { inc: (name: string, labels: any = {}) => { metrics.push({ name, labels }); }, set() {}, observe() {} },
    };
    // Like the real worker core (services/worker/src/core/consumer.ts:58): ctx.db.tx REUSES the job transaction — fn(ctx), no new tx, no isolation option.
    ctx.db = { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) };
    return ctx;
  };
  return {
    events, metrics, log: l,
    /** One attempt. Rejects when the handler throws (after rolling back ctx.tx). */
    async run(payload: any, attempt = o.attempt ?? 1, maxAttempts = o.maxAttempts ?? 3) {
      const tx = db.begin(tenantId, SYS);
      try { await handler(payload, build(tx, attempt, maxAttempts)); tx.commit(); } catch (e) { tx.rollback(); throw e; }
    },
  };
}

// ------------------------------------------------------------------------------------------------------------- seeding
export const PRICE_LIST_ID = uid(500);
export const PLV3 = uid(803);                 // published version 3 of RETAIL
export const PLV4_DRAFT = uid(804);
export const NAME_FORMULA = '=HYPERLINK("http://example.test/x","click")';
export const NAME_PLUS = '+SUM(1+1)';
export const NAME_AT = '@cmd';
export const NAME_QUOTE = "'already quoted";

/** Orderables (A4 is NOT in v3). `paise` = unit price in v3 (null = not in v3). */
export const CAT = [
  { id: uid(1), code: 'A1', kind: 'test', name: 'Glucose fasting', dept: 'CHEM', paise: 10000 },
  { id: uid(2), code: 'A2', kind: 'test', name: NAME_FORMULA, dept: 'CHEM', paise: 20050 },
  { id: uid(3), code: 'PNL1', kind: 'panel', name: NAME_PLUS, dept: 'HAEM', paise: 12345 },
  { id: uid(4), code: 'A4', kind: 'test', name: NAME_AT, dept: 'HAEM', paise: null as number | null },
] as const;
export const DEPTS = [
  { id: uid(11), code: 'CHEM', name: 'Chemistry', report_order: 10, report_heading: 'Clinical chemistry' },
  { id: uid(12), code: 'HAEM', name: 'Haematology', report_order: 20, report_heading: null as string | null },
];

const stamp = { version: 1, is_active: true, created_at: new Date(NOW), created_by: USER, updated_at: new Date(NOW), updated_by: USER };

/** Tenant A: RETAIL price list with published v3 (+ a draft v4 with other prices), departments, orderables, catalog_state(revision 7).
 *  Tenant B: a price list version + orderable + doctor + department that must never show up in tenant A's exports. */
export function seedCatalog(db: ExportsDb, tenantId = TENANT_A) {
  const b = tenantId === TENANT_B;
  const n = (x: number) => (b ? x + 5000 : x);
  const idOf = (id: string) => (b ? id.replace('0190c322', '0190c3b2') : id);
  db.seed.rows('departments', ...DEPTS.map((d) => ({ ...d, id: idOf(d.id), tenant_id: tenantId, ...stamp })));
  db.seed.rows('orderables', ...CAT.map((o) => ({ id: idOf(o.id), tenant_id: tenantId, kind: o.kind, code: b ? `B-${o.code}` : o.code, name: b ? `TENANT-B ${o.name}` : o.name,
    department_id: idOf(DEPTS.find((d) => d.code === o.dept)!.id), is_orderable: true, revision: 1, ...stamp })));
  db.seed.rows('price_lists', { id: idOf(PRICE_LIST_ID), tenant_id: tenantId, code: b ? 'RETAIL-B' : 'RETAIL', name: 'Retail (synthetic)', owner_kind: 'default', ...stamp });
  const v3 = idOf(PLV3);
  db.seed.rows('price_list_versions',
    { id: v3, tenant_id: tenantId, price_list_id: idOf(PRICE_LIST_ID), version_no: 3, status: 'published', effective_from: new Date('2026-01-01T00:00:00Z'), effective_to: null, item_count: 3, change_reason: 'seed', published_at: new Date('2026-01-01T00:00:00Z'), published_by: USER, ...stamp },
    { id: idOf(PLV4_DRAFT), tenant_id: tenantId, price_list_id: idOf(PRICE_LIST_ID), version_no: 4, status: 'draft', effective_from: null, effective_to: null, item_count: 1, ...stamp });
  db.seed.rows('price_list_items',
    ...CAT.filter((o) => o.paise !== null).map((o, i) => ({ id: uid(n(900 + i)), tenant_id: tenantId, price_list_version_id: v3, orderable_id: idOf(o.id), unit_price_paisa: o.paise!, ...stamp })),
    { id: uid(n(950)), tenant_id: tenantId, price_list_version_id: idOf(PLV4_DRAFT), orderable_id: idOf(CAT[0].id), unit_price_paisa: 77700, ...stamp });
  db.seed.rows('catalog_state', { tenant_id: tenantId, catalog_root_id: V7(b ? '00000000c3b0' : '00000000c3a0'), catalog_revision: b ? 99 : 7, global_release_seen: 0 });
}

export const PLANTED_DOCTORS: Row[] = [
  { id: uid(21), doctor_code: 'DR1', display_name: '=cmd|calc!A0', qualification: 'MD General Medicine', registration_council: 'NMC', registration_no: '12345', phone_e164: '+9779800000001', email: 'dr1@example.test', notes: 'PLANTED-NOTE-1', is_verified: true, source: 'back_office' },
  { id: uid(22), doctor_code: 'DR2', display_name: 'Dr. Sita Example', qualification: null, registration_council: null, registration_no: null, phone_e164: null, email: null, notes: null, is_verified: false, source: 'quick_add' },
];
export function seedDoctors(db: ExportsDb) {
  db.seed.rows('doctors', ...PLANTED_DOCTORS.map((d) => ({ ...d, tenant_id: TENANT_A, merged_into_id: null, ...stamp })));
  db.seed.rows('doctors', { id: uid(5021), tenant_id: TENANT_B, doctor_code: 'DRB', display_name: 'TENANT-B Doctor', phone_e164: '+9779800000999', email: 'b@example.test', is_verified: true, source: 'back_office', merged_into_id: null, ...stamp });
}
