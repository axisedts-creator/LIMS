// C16.T-BK1 test world (NOT a test file): patient-side booking harness over the in-house SQL interpreter fakeSql.ts (same engine as the staff T-B3 tests), for E30-E40
// (02-TRD §4.8, §5; 05-SCHEMA bookings / booking_items / booking_transitions / slot_occupancy / addresses / account_patient_links; 07-SECURITY AB-6, AB-7, AB-10, P-L1, P-L5).
// What it adds over the staff harness (booking.handlers.test.ts):
//   * PATIENT RLS (PAT_ACC, 05-SCHEMA §5): a patient session sees only ITS account's accounts / account_patient_links / addresses / bookings / booking_items / booking_transitions rows
//     (a staff-entered address or booking has account_id NULL and is therefore invisible); the same predicate is the WITH CHECK of INSERTs (42501 -> the service maps it to common.not_found).
//     Catalogue tables (booking_centres, slot_templates, slot_blackouts, slot_occupancy, bookable_items, settings) are tenant-wide readable. The service must still bind account_id / tenant_id itself.
//   * A REAL TRANSACTION per request: every statement is journalled per session; when the handler throws, that session's writes (incl. core.event_log rows written by the REAL core createEvents) are undone,
//     numeric columns by delta so concurrent sessions are not clobbered. Port calls are not rolled back. Row locks are NOT modelled (FOR UPDATE waits only).
//   * Events = the REAL core `createEvents({producer:'engagement'})` as ctx.events (envelope validated against contracts/events/*.schema.json; ON CONFLICT (tenant_id,event_type,idempotency_key) DO NOTHING).
// ctx = {tenantId, actor:{type:'patient', id:user_id}, claims:{membership_id,...}, tx, now:()=>ISO, events, ports:{IdentityPort}, log, operationId}. FrontdeskPort is deliberately ABSENT: the patient path
// takes the sex from the link `sex_snapshot` (03-APP-FLOW §6.1 wizard rules, US-EN-12.5), never from a port.
// Supported SQL = fakeSql.ts (no JOIN / OR / sub-select; `col = ANY($n)`, IN, IS NULL, comparisons, `booked = booked + 1`); the coded-set read (g_cs_*) is answered from CANCEL_REASONS.
import { createEvents } from '../../../core/events/publish.js';
import { FakeDb, queueSchemaDefs, type Call, type Row, type TableDef } from './fakeSql.js';
import { ID, T0, TENANT_A, TENANT_B } from './otp.world.js';

export { ID, T0, TENANT_A, TENANT_B };
export type { Row, Call };

export const A = TENANT_A, B = TENANT_B;
export const NOW = '2026-11-10T04:15:00.000Z'; // Tue 10:00 NPT (UTC+05:45)
export const MON = '2026-11-16';               // Monday; 07:00 NPT = 01:15Z
export const S = (hhmmZ: string) => `${MON}T${hhmmZ}:00.000Z`;
export const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();
export const SLOT = S('01:15');       // Mon 07:00 NPT at C1, no occupancy row yet, capacity 3
export const SLOT_ONE = S('01:45');   // 07:30 NPT, occupancy 2/3 (one place left)
export const SLOT_FULL = S('01:30');  // 07:15 NPT, occupancy 3/3
export const SLOT_2 = S('02:00');     // 07:45 NPT, empty (reschedule target)
export const SLOT_NEAR = '2026-11-10T04:45:00.000Z'; // 30 min after NOW: inside the 60-min cancel cutoff (and inside the 120-min booking lead)
export const C1 = ID(0xc01), C2 = ID(0xc02), CH = ID(0xc0a) /* home-collection centre H */, CI = ID(0xc0b) /* inactive */, CB = ID(0xcb1) /* tenant B */, C12 = ID(0xc0c) /* capacity 12 */;
export const BR1 = ID(0x11), BR2 = ID(0x12), BRH = ID(0x1a), BRB = ID(0x1b);
export const O = { CBC: ID(0x301), GLU: ID(0x302), WHP: ID(0x303) /* female only */, HOME_ONLY: ID(0x304), OFF: ID(0x305), PSA: ID(0x306) /* male only */, UNKNOWN: ID(0x3ff), B_ONLY: ID(0x3b1) };
export const PERMS = { READ: 'engagement.self.read', MANAGE: 'engagement.self.manage', CREATE: 'engagement.booking.create', CANCEL: 'engagement.booking.cancel' };
export const CANCEL_REASONS = [
  { code: 'patient_request', display: 'Patient request', sort_order: 1, is_active: true }, { code: 'rescheduled', display: 'Rescheduled', sort_order: 2, is_active: true },
  { code: 'duplicate', display: 'Duplicate booking', sort_order: 3, is_active: true }, { code: 'lab_unavailable', display: 'Lab unavailable', sort_order: 4, is_active: true },
];

const T = (iso: string) => ({ created_at: iso, updated_at: iso });
export const centre = (id: string, tenant: string, branch: string, name: string, o: Row = {}): Row => ({ id: ID(parseInt(id.slice(-4), 16) + 0x2000), tenant_id: tenant, centre_id: id, branch_id: branch, display_name: name, address_text: 'Synthetic Road 1',
  is_active: true, synced_at: NOW, ...T(NOW), created_by: tenant, updated_by: tenant, ...o });
export const tpl = (id: string, tenant: string, centreId: string, o: Row = {}): Row => ({ id, tenant_id: tenant, centre_id: centreId, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00:00', end_local: '11:00:00', slot_minutes: 15, capacity: 3,
  effective_from: '2026-01-01', effective_to: null, version: 5, is_active: true, ...T(NOW), created_by: tenant, updated_by: tenant, ...o });
export const occ = (id: string, centreId: string, template: string, start: string, booked: number, o: Row = {}): Row => ({ id, tenant_id: A, centre_id: centreId, booking_kind: 'centre_visit', slot_start: start, slot_end: plus(start, 15), template_id: template, capacity: 3, booked,
  version: 2, is_active: true, ...T(NOW), created_by: A, updated_by: A, ...o });
export const item = (n: number, oid: string, kind: string, name: string, o: Row = {}): Row => ({ id: ID(0xd000 + n), tenant_id: A, orderable_id: oid, orderable_kind: kind, code: name.replace(/[^A-Za-z]/g, '').slice(0, 5).toUpperCase(), display_name: name, indicative_price_paisa: 45000,
  price_list_id: null, price_list_version: null, sex_restriction: null, booking_kinds: ['centre_visit', 'home_collection'], sort_order: n, catalog_revision: 1, synced_at: NOW, version: 1, is_active: true, ...T(NOW), created_by: A, updated_by: A, ...o });
export const settings = (o: Row = {}): Row => ({ id: ID(0xe001), tenant_id: A, bookings_enabled: true, home_collection_enabled: true, home_collection_centre_id: CH, queue_enabled: true, auto_no_show: true, booking_horizon_days: 14, booking_min_lead_minutes: 120,
  booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120, max_active_bookings_per_profile: 2, max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, version: 1, ...o });

const BOOKING_COLS = ['id', 'tenant_id', 'booking_no', 'account_id', 'patient_id', 'link_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'home_address_id', 'status', 'order_id', 'queue_token_id', 'confirmed_at',
  'checked_in_at', 'completed_at', 'cancelled_at', 'cancel_reason_code', 'cancelled_by_kind', 'replaces_booking_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const ADDR_COLS = ['id', 'tenant_id', 'account_id', 'patient_id', 'label', 'address_text', 'landmark', 'municipality', 'ward_no', 'district', 'latitude', 'longitude', 'contact_phone_e164', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  ...queueSchemaDefs(clock),
  collection_centres: { columns: ['id', 'tenant_id'] },
  settings: { columns: Object.keys(settings()) },
  accounts: { columns: ['id', 'tenant_id', 'membership_id', 'user_id', 'phone_e164', 'phone_hmac', 'status', 'reminders_opt_out', 'last_login_at', 'version'] },
  account_patient_links: { columns: ['id', 'tenant_id', 'account_id', 'patient_id', 'relationship', 'method', 'status', 'display_name', 'sex_snapshot', 'visible_from', 'version', 'created_at', 'updated_at'] },
  booking_centres: { columns: Object.keys(centre(C1, A, BR1, 'x')) },
  slot_templates: { columns: Object.keys(tpl(ID(1), A, C1)) },
  slot_blackouts: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'starts_at', 'ends_at', 'reason_code', 'note', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  slot_occupancy: {
    columns: Object.keys(occ(ID(1), C1, ID(1), NOW, 0)), notNull: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'created_by', 'updated_by'],
    defaults: { booked: 0, version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id'], ['tenant_id', 'centre_id', 'booking_kind', 'slot_start']],
    fk: [{ cols: ['tenant_id', 'template_id'], ref: 'slot_templates', refCols: ['tenant_id', 'id'] }],
    check: (r) => (r['booked'] < 0 ? 'slot_occupancy__booked__ck' : !(r['capacity'] >= 1 && r['capacity'] <= 100) ? 'slot_occupancy__capacity__ck' : undefined), // no booked <= capacity CHECK: the conditional UPDATE is the guard
  },
  bookable_items: { columns: Object.keys(item(1, O.CBC, 'test', 'x')) },
  addresses: {
    columns: ADDR_COLS, notNull: ['id', 'tenant_id', 'patient_id', 'label', 'address_text', 'version', 'is_active', 'created_by', 'updated_by'], defaults: { version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'account_id'], ref: 'accounts', refCols: ['tenant_id', 'id'] }],
    mutable: ['label', 'address_text', 'landmark', 'municipality', 'ward_no', 'district', 'latitude', 'longitude', 'contact_phone_e164', 'version', 'is_active', 'updated_at', 'updated_by'],
    check: (r) => !['home', 'work', 'other'].includes(r['label']) ? 'addresses__label__ck' : !(typeof r['address_text'] === 'string' && r['address_text'].length >= 1 && r['address_text'].length <= 300 && (r['landmark'] == null || r['landmark'].length <= 120)
      && (r['municipality'] == null || r['municipality'].length <= 80) && (r['district'] == null || r['district'].length <= 60)) ? 'addresses__lengths__ck' : r['ward_no'] != null && !(r['ward_no'] >= 1 && r['ward_no'] <= 99) ? 'addresses__ward__ck'
      : r['contact_phone_e164'] != null && !/^\+[1-9][0-9]{7,14}$/.test(r['contact_phone_e164']) ? 'addresses__phone__ck' : undefined,
  },
  bookings: {
    columns: BOOKING_COLS, notNull: ['id', 'tenant_id', 'booking_no', 'patient_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'status', 'confirmed_at', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'confirmed', version: 1, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id'], ['tenant_id', 'booking_no']],
    fk: [{ cols: ['tenant_id', 'slot_occupancy_id'], ref: 'slot_occupancy', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] },
      { cols: ['tenant_id', 'home_address_id'], ref: 'addresses', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'replaces_booking_id'], ref: 'bookings', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'account_id'], ref: 'accounts', refCols: ['tenant_id', 'id'] }],
    mutable: ['status', 'order_id', 'queue_token_id', 'checked_in_at', 'completed_at', 'cancelled_at', 'cancel_reason_code', 'cancelled_by_kind', 'updated_at', 'updated_by', 'version'],
    check: (r) => !/^[A-Z0-9]{4,20}$/.test(r['booking_no']) ? 'bookings__no__ck' : !['app', 'staff'].includes(r['created_via']) ? 'bookings__via__ck'
      : (r['created_via'] === 'app') !== (r['account_id'] != null && r['link_id'] != null) ? 'bookings__via_account__ck' : (r['booking_kind'] === 'home_collection') !== (r['home_address_id'] != null) ? 'bookings__address_kind__ck'
      : !['confirmed', 'checked_in', 'completed', 'cancelled'].includes(r['status']) ? 'bookings__status__ck' : (r['status'] === 'cancelled') !== (r['cancelled_at'] != null && r['cancel_reason_code'] != null && r['cancelled_by_kind'] != null) ? 'bookings__cancel__ck'
      : r['cancelled_by_kind'] != null && !['patient', 'staff', 'system'].includes(r['cancelled_by_kind']) ? 'bookings__cancel_by__ck' : !(Date.parse(r['slot_end']) > Date.parse(r['slot_start'])) ? 'bookings__range__ck' : undefined,
  },
  booking_items: { columns: ['id', 'tenant_id', 'booking_id', 'account_id', 'centre_id', 'orderable_id', 'orderable_kind', 'display_name_snapshot', 'indicative_price_paisa', 'sort_order', 'created_at', 'created_by'],
    notNull: ['id', 'tenant_id', 'booking_id', 'centre_id', 'orderable_id', 'orderable_kind', 'display_name_snapshot', 'sort_order', 'created_by'], unique: [['tenant_id', 'id'], ['tenant_id', 'booking_id', 'orderable_id']], defaults: { created_at: clock.iso } },
  booking_transitions: { columns: ['id', 'tenant_id', 'booking_id', 'account_id', 'centre_id', 'from_status', 'to_status', 'reason_code', 'actor_type', 'actor_id', 'occurred_at', 'created_at', 'created_by'],
    notNull: ['id', 'tenant_id', 'booking_id', 'centre_id', 'to_status', 'actor_type', 'actor_id', 'occurred_at', 'created_by'], defaults: { created_at: clock.iso },
    check: (r) => !['user', 'system', 'patient'].includes(r['actor_type']) ? 'booking_transitions__actor__ck' : !['confirmed', 'checked_in', 'completed', 'cancelled'].includes(r['to_status']) ? 'booking_transitions__status__ck' : undefined },
  number_counters: { columns: ['tenant_id', 'counter_key', 'last_value', 'expires_at', 'created_at', 'created_by', 'updated_at'], notNull: ['tenant_id', 'counter_key', 'last_value', 'created_by'], defaults: { last_value: 0, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'counter_key']], check: (r) => (/^(booking_no|card_no):[0-9]{2}$|^otp_day:[0-9]{8}$|^linkfail:[0-9a-f-]{36}:[0-9]{10}$/.test(r['counter_key']) ? undefined : 'number_counters__key__ck') },
  event_log: { columns: ['tenant_id', 'event_id', 'event_type', 'producer', 'idempotency_key', 'aggregate_type', 'aggregate_id', 'aggregate_seq', 'occurred_at', 'envelope', 'created_by'], unique: [['tenant_id', 'event_type', 'idempotency_key']] },
});

// PAT_ACC: tables whose rows a patient sees only when account_id = its own account (accounts: id).
const OWN: Record<string, string> = { accounts: 'id', account_patient_links: 'account_id', addresses: 'account_id', bookings: 'account_id', booking_items: 'account_id', booking_transitions: 'account_id' };

export interface WorldOpts { settings?: Row; extra?: (t: Record<string, Row[]>) => void }
export interface Who { account: Row; grants?: readonly string[] | null; actorType?: 'patient' | 'user' | 'display' | 'preauth'; tenant?: string }

const sameVal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function makeBookingWorld(o: WorldOpts = {}) {
  const clock = { iso: NOW };
  const tables: Record<string, Row[]> = {
    collection_centres: [C1, C2, CH, CI, C12].map((id) => ({ id, tenant_id: A })).concat([{ id: CB, tenant_id: B }]),
    booking_centres: [centre(C1, A, BR1, 'Synthetic Centre One'), centre(C2, A, BR2, 'Synthetic Centre Two'), centre(CH, A, BRH, 'Synthetic Home Base'), centre(CI, A, BR1, 'Synthetic Closed Centre', { is_active: false }),
      centre(C12, A, BR1, 'Synthetic Big Centre'), centre(CB, B, BRB, 'Synthetic Centre B')],
    settings: [settings(o.settings)],
    slot_templates: [tpl(ID(0x101), A, C1), tpl(ID(0x103), A, C2), tpl(ID(0x10a), A, CH, { booking_kind: 'home_collection', start_local: '07:00:00', end_local: '12:00:00', slot_minutes: 60, capacity: 5 }),
      tpl(ID(0x10c), A, C12, { capacity: 12 }), tpl(ID(0x1b1), B, CB, { tenant_id: B })],
    slot_blackouts: [{ id: ID(0x2b01), tenant_id: A, centre_id: C1, booking_kind: 'centre_visit', starts_at: '2026-11-18T01:15:00.000Z', ends_at: '2026-11-18T03:15:00.000Z', reason_code: 'maintenance', note: null, version: 1, is_active: true, ...T(NOW), created_by: A, updated_by: A }],
    slot_occupancy: [occ(ID(0x601), C1, ID(0x101), SLOT_FULL, 3), occ(ID(0x602), C1, ID(0x101), SLOT_ONE, 2), occ(ID(0x603), C1, ID(0x101), SLOT_NEAR, 1)],
    bookable_items: [item(1, O.CBC, 'test', 'Complete Blood Count'), item(2, O.GLU, 'test', 'Glucose Fasting', { indicative_price_paisa: 20000 }), item(3, O.WHP, 'panel', "Women's Health Package", { sex_restriction: 'female', indicative_price_paisa: 250000 }),
      item(4, O.HOME_ONLY, 'test', 'Home Only Test', { booking_kinds: ['home_collection'] }), item(5, O.OFF, 'test', 'Retired Test', { is_active: false }), item(6, O.PSA, 'test', 'Prostate Marker', { sex_restriction: 'male', indicative_price_paisa: null }),
      item(7, O.B_ONLY, 'test', 'Tenant B Test', { tenant_id: B })],
    accounts: [], account_patient_links: [], addresses: [], bookings: [], booking_items: [], booking_transitions: [], number_counters: [], event_log: [],
    queue_definitions: [], queue_counters: [], queue_day_counters: [], queue_tokens: [],
  };
  o.extra?.(tables);
  const db = new FakeDb(tables, defs(clock), clock);
  let seq = 0x4000; const newId = () => ID(++seq);

  // ---- patient RLS (instance override of the private row filter) ----------------------------------------------------------------------------------------------
  // The original filter gets (row, tenant, scope) only: the table is recovered from the row identity; an INSERT checks a row that is not in its table yet, so it is recognised by its column set.
  const tableOf = (row: Row): string | undefined => Object.keys(db.tables).find((k) => db.tables[k]!.includes(row))
    ?? ('booking_no' in row ? 'bookings' : 'display_name_snapshot' in row ? 'booking_items' : 'to_status' in row ? 'booking_transitions' : 'address_text' in row && 'label' in row ? 'addresses' : undefined);
  (db as any).visible = (row: Row, tenant: string, scope: { accountId?: string }) => {
    if (row['tenant_id'] !== tenant) return false;
    const table = scope.accountId ? tableOf(row) : undefined;
    return table === undefined || !(table in OWN) ? true : row[OWN[table]!] === scope.accountId;
  };

  // ---- per-session undo journal (statement diffs against a shadow copy; numeric columns by delta) --------------------------------------------------------------
  const shadow = new Map<Row, Row>(); const shadowRows = new Map<string, Row[]>();
  const absorb = () => { shadow.clear(); for (const [k, rows] of Object.entries(db.tables)) { shadowRows.set(k, [...rows]); for (const r of rows) shadow.set(r, structuredClone(r)); } };
  absorb();
  type Undo = { kind: 'ins'; table: string; row: Row } | { kind: 'upd'; row: Row; before: Row; after: Row };
  const journal = new Map<number, Undo[]>();
  const origExec = (db as any).exec.bind(db);
  (db as any).exec = async (session: number, tenant: string, scope: any, text: string, values: unknown[]) => {
    try { return await origExec(session, tenant, scope, text, values); } finally {
      const log = journal.get(session) ?? []; journal.set(session, log);
      for (const [k, rows] of Object.entries(db.tables)) {
        const was = shadowRows.get(k) ?? [];
        for (const r of rows) { if (!was.includes(r)) log.push({ kind: 'ins', table: k, row: r }); else if (!sameVal(shadow.get(r), r)) log.push({ kind: 'upd', row: r, before: shadow.get(r)!, after: structuredClone(r) }); }
      }
      absorb();
    }
  };
  const undo = (session: number) => {
    for (const u of (journal.get(session) ?? []).reverse()) {
      if (u.kind === 'ins') { const rows = db.tables[u.table]!; const i = rows.indexOf(u.row); if (i >= 0) rows.splice(i, 1); continue; }
      for (const c of new Set([...Object.keys(u.before), ...Object.keys(u.after)])) {
        const b = u.before[c], a = u.after[c];
        if (sameVal(a, b)) continue;
        if (typeof a === 'number' && typeof b === 'number' && typeof u.row[c] === 'number') u.row[c] = u.row[c] - (a - b); else if (sameVal(u.row[c], a)) u.row[c] = b;
      }
    }
    journal.delete(session); absorb();
  };

  // ---- identity / ports / ctx ------------------------------------------------------------------------------------------------------------------------------------
  const identityCalls: Array<{ permission: string; at: number }> = [];
  const logs: unknown[] = [];
  const log: any = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a), child: () => log };
  const identityFor = (grants: readonly string[] | null) => ({
    async assertRole(_c: unknown, r: { permission: string }) { identityCalls.push({ permission: r?.permission, at: db.calls.length }); if (grants && !grants.includes(r?.permission)) throw Object.assign(new Error('auth.forbidden'), { code: 'auth.forbidden', statusCode: 403 }); },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', calendarDisplay: 'AD_BS' }; },
  });
  const ALL_PERMS = Object.values(PERMS);

  /** Runs one request as one transaction: its writes are undone when the handler throws. `who.account` null = a pre-auth / display actor without an account. */
  async function call(handlers: Record<string, any>, op: string, who: Who, req: { params?: object; query?: object; headers?: object; body?: unknown } = {}): Promise<{ out?: any; error?: any; calls: Call[]; session: number }> {
    const tenant = who.tenant ?? A;
    absorb(); // rows seeded / edited directly by the test since the last statement are committed state, not part of this request (statement writes are absorbed as they happen)
    const s = db.session(tenant, { all: true, centres: [], accountId: who.actorType && who.actorType !== 'patient' ? undefined : who.account['id'] } as any, who.account['user_id']);
    const query = (text: string, values: unknown[] = []) => {
      if (/engagement\.g_cs_booking_cancel_reasons/i.test(text)) { db.calls.push({ text, values }); return Promise.resolve({ rows: CANCEL_REASONS.map((x) => ({ ...x })), rowCount: CANCEL_REASONS.length }); }
      return s.tx.query(text, values);
    };
    const type = who.actorType ?? 'patient';
    const ctx: any = { operationId: op, tenantId: tenant, requestId: ID(0xe1), clientIp: '203.0.113.9', actor: { type, id: who.account['user_id'] }, claims: { sub: who.account['user_id'], tenant_id: tenant, membership_id: who.account['membership_id'], actor_type: type, aal: 'aal1' },
      tx: { query, startedAt: new Date(clock.iso) }, now: () => clock.iso, log, events: createEvents({ producer: 'engagement', log }), ports: { IdentityPort: identityFor(who.grants === undefined ? ALL_PERMS : who.grants) } };
    const since = db.calls.length;
    const full = { params: {}, query: {}, body: undefined, ...req, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android', ...(req.headers ?? {}) } };
    try { const out = await handlers[op](full, ctx); s.release(); journal.delete(s.id); return { out, calls: db.calls.slice(since), session: s.id }; }
    catch (error) { undo(s.id); s.release(); return { error, calls: db.calls.slice(since), session: s.id }; }
  }

  // ---- seeds -------------------------------------------------------------------------------------------------------------------------------------------------------
  const api = {
    db, t: db.tables, clock, call, logs, identityCalls, newId, ID,
    setNow: (iso: string) => { clock.iso = iso; },
    setSetting: (k: string, v: unknown) => { db.tables['settings']![0]![k] = v; },
    snapshot: () => JSON.stringify(db.tables),
    dml: (calls: Call[]) => calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    seedAccount: (over: Row = {}): Row => { const a: Row = { id: newId(), tenant_id: A, membership_id: newId(), user_id: newId(), phone_e164: '+99001000001', phone_hmac: 'x', status: 'active', reminders_opt_out: false, last_login_at: NOW, version: 1, ...over }; db.tables['accounts']!.push(a); return a; },
    /** An ACTIVE profile (link) of `account` for patient `patientId`; sex_snapshot null = unknown to C16 (US-EN-12.5). */
    seedLink: (account: Row, patientId: string, over: Row = {}): Row => { const l: Row = { id: newId(), tenant_id: account['tenant_id'], account_id: account['id'], patient_id: patientId, relationship: 'self', method: 'link_code', status: 'active', display_name: 'Synthetic Patient', sex_snapshot: 'female', visible_from: null, version: 1, ...T(NOW), ...over }; db.tables['account_patient_links']!.push(l); return l; },
    seedAddress: (account: Row | null, patientId: string, over: Row = {}): Row => { const r: Row = { id: newId(), tenant_id: A, account_id: account ? account['id'] : null, patient_id: patientId, label: 'home', address_text: 'Synthetic Lane 7, Ward 3', landmark: null, municipality: null, ward_no: null, district: null,
      latitude: null, longitude: null, contact_phone_e164: null, version: 1, is_active: true, ...T(NOW), created_by: account ? account['user_id'] : A, updated_by: account ? account['user_id'] : A, ...over }; db.tables['addresses']!.push(r); return r; },
    /** A booking row (+ one item + the confirmed transition). `link` null = staff booking (account_id NULL). */
    seedBooking: (account: Row | null, link: Row | null, patientId: string, over: Row = {}): Row => {
      const id = over['id'] ?? newId(); const n = db.tables['bookings']!.length + 1;
      const occId = over['slot_occupancy_id'] ?? ID(0x601);
      const b: Row = { id, tenant_id: A, booking_no: `BK26${String(900 + n).padStart(6, '0')}`, account_id: account ? account['id'] : null, patient_id: patientId, link_id: link ? link['id'] : null, created_via: account ? 'app' : 'staff', booking_kind: 'centre_visit', branch_id: BR1, centre_id: C1,
        slot_occupancy_id: occId, slot_start: S('02:15'), slot_end: S('02:30'), home_address_id: null, status: 'confirmed', order_id: null, queue_token_id: null, confirmed_at: NOW, checked_in_at: null, completed_at: null, cancelled_at: null, cancel_reason_code: null, cancelled_by_kind: null,
        replaces_booking_id: null, version: 1, ...T(NOW), created_by: account ? account['user_id'] : A, updated_by: account ? account['user_id'] : A, ...over };
      db.tables['bookings']!.push(b);
      db.tables['booking_items']!.push({ id: newId(), tenant_id: A, booking_id: id, account_id: b['account_id'], centre_id: b['centre_id'], orderable_id: O.CBC, orderable_kind: 'test', display_name_snapshot: 'Complete Blood Count', indicative_price_paisa: 45000, sort_order: 0, created_at: NOW, created_by: A });
      db.tables['booking_transitions']!.push({ id: newId(), tenant_id: A, booking_id: id, account_id: b['account_id'], centre_id: b['centre_id'], from_status: null, to_status: 'confirmed', reason_code: null, actor_type: account ? 'patient' : 'user', actor_id: b['created_by'], occurred_at: NOW, created_at: NOW, created_by: A });
      return b;
    },
    /** An occupancy row for the slot of a seeded booking (so the booking's slot_occupancy_id resolves and release / reserve have a row). */
    seedOccupancy: (slotStart: string, booked: number, over: Row = {}): Row => { const r = occ(newId(), C1, ID(0x101), slotStart, booked, over); db.tables['slot_occupancy']!.push(r); return r; },
    events: (type?: string) => db.tables['event_log']!.filter((e) => !type || e['event_type'] === type).map((e) => e['envelope']),
    row: (table: string, id: string): Row | undefined => db.tables[table]!.find((r) => r['id'] === id),
    occupancyAt: (slotStart: string, centreId = C1, kind = 'centre_visit'): Row | undefined => db.tables['slot_occupancy']!.find((r) => r['centre_id'] === centreId && r['booking_kind'] === kind && Date.parse(r['slot_start']) === Date.parse(slotStart)),
    jobs: (calls: Call[], identifier: string) => calls.filter((c) => /app\.enqueue_job/i.test(c.text) && c.values[0] === identifier),
    observed: () => JSON.stringify(logs),
  };
  return api;
}
export type BookingWorld = ReturnType<typeof makeBookingWorld>;
