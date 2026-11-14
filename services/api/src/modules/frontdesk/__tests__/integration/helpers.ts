// FD-T03 helpers: real PG17 (migrated + seeded), tenant_a / tenant_b synthetic fixtures. Synthetic data only.
// Env (set by tests/frontdesk/FD-T03.pg.sh, or by hand against a migrated + seeded DB):
//   LIMS_TEST_APP_URL   login `lims_api` (inherits lims_app, NOBYPASSRLS, search_path '')  -> every repo call runs here, under RLS
//   LIMS_TEST_SUPER_URL superuser (bypasses RLS)                                           -> fixtures + "no RLS" explicit-filter proof + owner checks
// Missing env or missing `pg` module is a hard failure (never a skip). `pg` must be a devDependency of services/api (FD-T03 writer).
// Repo contract assumed by these tests: see .orchestra/notes/FD-T03-tests.md.
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';
export const TENANT_A ='01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SYS_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const BRANCH = { a: '01a1a98a-ac40-7000-8000-00000000a101', b: '01a1a98a-ac40-7000-8000-00000000b101' } as const;
export const CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a201', b: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
export const TENANT = { a: TENANT_A, b: TENANT_B } as const;
export type Side = 'a' | 'b';

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run .orchestra\\notes\\FD-T03-verify.cmd (boots PG17 via docker) or export it against a migrated + seeded DB`);
  return v;
};
const pgModule = 'pg'; // variable specifier: no tsc error before the writer adds the dependency
const { default: pg } = (await import(pgModule)) as any;
const app = new pg.Pool({ connectionString: need('LIMS_TEST_APP_URL'), max: 40 });
const sup = new pg.Pool({ connectionString: need('LIMS_TEST_SUPER_URL'), max: 4 });
export const closePools = async () => { await app.end(); await sup.end(); };

// Ruling FD-T04 #1: internal ids are UUIDv7 (02-CONVENTIONS:452/525; core/audit/access.ts enforces it on entityId).
export const uid = (): string => uuidv7();
export const hex64 = (): string => (uid() + uid()).replace(/-/g, '').slice(0, 64);

const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS_ACTOR, actor_type: 'system' });

/** Request-style tx as lims_api under RLS with `claimsTenant`'s claims (set_config is tx-local). Commits on success, rolls back on throw. */
export async function appTx<T>(claimsTenant: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(claimsTenant)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
/** Superuser tx: RLS is bypassed, so only a repo's own explicit tenant_id filter can keep tenants apart. Claims set so audit triggers have an actor. */
export async function superTx<T>(fn: (tx: Tx) => Promise<T>, claimsTenant = TENANT_A): Promise<T> {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(claimsTenant)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** Fixture insert as superuser (idempotent). Stamps created_by / updated_by when the table has them. */
export async function seed(table: string, row: Record<string, unknown>): Promise<void> {
  const r = { created_by: SYS_ACTOR, updated_by: SYS_ACTOR, ...row };
  await superTx(async (tx) => {
    const cols = Object.keys(r);
    const has = (await tx.query(
      `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [table])).rows.map((x) => x.attname);
    const use = cols.filter((c) => has.includes(c));
    const list = use.map((c) => `"${c}"`).join(',');
    await tx.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify(Object.fromEntries(use.map((c) => [c, r[c]])))]);
  }, String(r.tenant_id ?? TENANT_A));
}
/** Owner-side truth: rows of `table` matching `where` (no RLS). */
export async function ownerRows(table: string, where: string, values: unknown[] = []): Promise<any[]> {
  return superTx(async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE ${where}`, values)).rows);
}

// ---- row builders (snake_case = DB columns; repos take and return raw rows) ----
let seq = 0;
const next = () => ++seq + Math.floor(Math.random() * 1e9) * 1000;
export const rows = {
  patient: (s: Side, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], patient_code: `FDT03-P${next()}`, full_name: `Asha Test ${s.toUpperCase()}`, name_search: `asha test ${s}`,
    sex: 'female', birth_on: '1990-01-01', phone_e164: '+9779800000001', source: 'front_desk', registered_centre_id: CENTRE[s], ...o }),
  consent: (s: Side, patientId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], patient_id: patientId, processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false,
    consent_text_version: 'v1', source: 'front_desk', captured_at: '2026-11-07T00:00:00Z', ...o }),
  order: (s: Side, patientId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], branch_id: BRANCH[s], centre_id: CENTRE[s], patient_id: patientId, registration_no: `FDT03-R${next()}`,
    status: 'registered', visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk',
    is_first_order_of_patient: true, catalog_revision: 1, registered_at: '2026-11-07T00:00:00Z', ...o }),
  item: (s: Side, orderId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], order_id: orderId, centre_id: CENTRE[s], orderable_id: uid(), orderable_kind: 'test', code: 'T1', name: 'Synthetic test',
    test_ids: [uid()], priority: 'routine', unit_price_paisa: 10000, price_list_id: uid(), price_list_version: 1, price_source: 'tenant_default',
    vat_treatment: 'exempt', added_in_items_version: 1, ...o }),
  approval: (s: Side, patientId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], centre_id: CENTRE[s], requested_by_membership_id: uid(), patient_id: patientId, base_fingerprint: hex64(), discounts: [],
    gross_paisa: 10000, computed_discount_paisa: 500, percent_of_gross_bp: 500, reason_code: 'promo', status: 'pending', expires_at: '2026-12-01T00:00:00Z', ...o }),
  discount: (s: Side, orderId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], order_id: orderId, centre_id: CENTRE[s], scope: 'bill', kind: 'amount', amount_paisa: 500, computed_paisa: 500,
    reason_code: 'promo', approval_mode: 'within_limit', applied_by_membership_id: uid(), approved_by_membership_id: uid(), applied_at: '2026-11-07T00:00:00Z', ...o }),
  trf: (s: Side, orderId: string | null, o: Record<string, unknown> = {}) => {
    const id = uid();
    return { id, tenant_id: TENANT[s], centre_id: CENTRE[s], order_id: orderId, object_path: `${TENANT[s]}/2026/11/${id}`, mime_type: 'application/pdf',
      size_bytes: 1000, sha256: hex64(), ...o };
  },
  flag: (s: Side, orderId: string, o: Record<string, unknown> = {}) => ({
    id: uid(), tenant_id: TENANT[s], centre_id: CENTRE[s], order_id: orderId, kind: 'recollection_required', specimen_id: uid(), ...o }),
  bookingLink: (s: Side, orderId: string | null, o: Record<string, unknown> = {}) => ({
    tenant_id: TENANT[s], source: 'engagement_booking', source_ref_id: uid(), order_id: orderId, state: 'converted', last_seq: 1, ...o }),
};

export interface World { patient: any; consent: any; order: any; item: any; approval: any; discount: any; trf: any; flag: any; link: any }
/** One full committed object graph per tenant. */
export async function seedWorld(s: Side): Promise<World> {
  const patient = rows.patient(s);
  await seed('frontdesk.patients', patient);
  const consent = rows.consent(s, patient.id); await seed('frontdesk.patient_consents', consent);
  const order = rows.order(s, patient.id); await seed('frontdesk.orders', order);
  const item = rows.item(s, order.id); await seed('frontdesk.order_items', item);
  const approval = rows.approval(s, patient.id); await seed('frontdesk.discount_approvals', approval);
  const discount = rows.discount(s, order.id); await seed('frontdesk.discounts', discount);
  const trf = rows.trf(s, order.id); await seed('frontdesk.trf_attachments', trf);
  const flag = rows.flag(s, order.id); await seed('frontdesk.order_flags', flag);
  const link = rows.bookingLink(s, order.id); await seed('frontdesk.booking_links', link);
  await seed('frontdesk.settings', { tenant_id: TENANT[s], consent_text_version: 'v1' });
  return { patient, consent, order, item, approval, discount, trf, flag, link };
}
