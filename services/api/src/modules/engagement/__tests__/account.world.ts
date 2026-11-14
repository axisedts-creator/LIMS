// C16.T-AC1 test world (tester-owned): E10 getMyAccount / E11 updateMyAccount / E12 deleteMyAccount on the shared FakeDb interpreter (fakeSql.ts; single-table statements only).
// Tables (05-SCHEMA): accounts (+ the partial unique indexes emulated as pg 23505), account_patient_links (linkDefs of link.report.world), addresses, payment_requests (ready/action checks),
//   and the LAB-RECORD tables the deletion must leave alone: patients, bookings, reminders, enquiries.
// RLS emulation for the PATIENT actor (05-SCHEMA §5.2): accounts S/U = own row only (INSERT = pre-auth only, never a signed-in patient); links / addresses / payment_requests / bookings / enquiries = own account only;
//   reminders = staff only (the patient sees and changes nothing). A patient UPDATE that hits a foreign row is silently filtered (RLS USING) AND counted in `foreignTouches` so a service that forgets its own
//   account filter fails the test even though the database would have protected it (REQ-SEC-024: every statement binds tenant_id and the account itself).
//   addresses UPDATE additionally needs an ACTIVE link to the row's patient (PAT_ACC_PID).
//   Patient column guard on account_patient_links (§4 guard_patient_link_update): only relationship/status/revoked_*/is_active/updated_*/version may change and status only to 'revoked' (else P0001 immutable_row).
// IdentityPort = a spy (`identity`): assertRole by grant set, revokePatientSessions recorded (caller actor type, tenant, exact input) with an injectable failure.
// `invoke` = one request: a fresh ctx + FakeDb session (released afterwards), one transaction like the core pipeline - tables, audit and jobs roll back when the handler throws (unless commitOnError()).
//   The IdentityPort spy is NOT rolled back (the call happened; C2 is another system).
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';
import { linkDefs } from './link.report.world.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const ACC1 = ID(0xa1), ACC2 = ID(0xa2), ACCB = ID(0xab); // A1 = the caller; A2 = another account of the same tenant; ACCB = tenant B
export const MEM1 = ID(0xe1), MEM2 = ID(0xe2), MEMB = ID(0xeb), SYSTEM = ID(0x5a), STAFF = ID(0x57);
export const PAT1 = ID(0x91), PAT2 = ID(0x92), PATB = ID(0x9b); // PAT1 is linked to A1 AND A2
export const PHONE1 = '+9779800000001', PHONE2 = '+9779800000002', PHONEB = '+9779800000003';
export const HMAC1 = Buffer.alloc(32, 1), HMAC2 = Buffer.alloc(32, 2), HMACB = Buffer.alloc(32, 3);
export const T0 = '2026-11-05T04:15:00.000Z'; // ctx.now()
export const V1 = 3; // accounts.version of A1 at the start (If-Match "3")
export const L_ACTIVE = ID(0xc1), L_ACTIVE2 = ID(0xc2), L_REVOKED = ID(0xc3), L_A2 = ID(0xc4), L_B = ID(0xcb);
export const PR_QUEUED = ID(0xd1), PR_READY = ID(0xd2), PR_DONE = ID(0xd3), PR_FAILED = ID(0xd4), PR_A2 = ID(0xd5), PR_B = ID(0xdb);
export const AD_1 = ID(0xf1), AD_2 = ID(0xf2), AD_OLD = ID(0xf3), AD_A2 = ID(0xf4), AD_B = ID(0xfb);
export const BK1 = ID(0xb1), RM1 = ID(0xb2), EQ1 = ID(0xb3);
export const REVOKED_EARLIER = '2026-10-20T00:00:00.000Z';
/** Seed hook: turns L_ACTIVE2 (PAT2, address AD_2) into a suspended link - the case the real guard / RLS cannot serve for a patient actor (review T-AC1 item 2). */
export const suspendLink = ({ tables }: { tables: Record<string, Row[]> }) => { Object.assign(tables['account_patient_links']!.find((l) => l['id'] === L_ACTIVE2)!, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: '2026-10-10T00:00:00.000Z' }); };
export const IFM = (v: number | string) => ({ 'if-match': `"${v}"` });
export const deep = (v: any): any => (v instanceof Uint8Array ? Buffer.from(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);

const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
const has = (v: unknown) => v !== null && v !== undefined;
const AUDIT_COLS = ['version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
export const defs = (): Record<string, TableDef> => ({
  ...linkDefs(),
  accounts: T(['id', 'tenant_id', 'membership_id', 'user_id', 'phone_e164', 'phone_hmac', 'status', 'reminders_opt_out', 'last_login_at', 'last_app_platform', 'last_app_version', 'deleted_at', ...AUDIT_COLS], {
    notNull: ['id', 'tenant_id', 'status', 'reminders_opt_out', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'active', reminders_opt_out: false, version: 1, is_active: true, membership_id: null, user_id: null, last_login_at: null, last_app_platform: null, last_app_version: null, deleted_at: null },
    unique: [['id'], ['tenant_id', 'id']],
    check: (r) => (!['active', 'deleted'].includes(r['status']) ? 'accounts__status__ck'
      : r['status'] !== 'deleted' && !(/^\+[1-9][0-9]{7,14}$/.test(String(r['phone_e164'])) && has(r['phone_hmac']) && Buffer.from(r['phone_hmac']).length === 32) ? 'accounts__phone__ck'
      : (r['status'] === 'deleted') !== has(r['deleted_at']) ? 'accounts__deleted__ck' : undefined),
  }),
  addresses: T(['id', 'tenant_id', 'account_id', 'patient_id', 'label', 'address_text', 'landmark', 'municipality', 'ward_no', 'district', 'latitude', 'longitude', 'contact_phone_e164', ...AUDIT_COLS], {
    notNull: ['id', 'tenant_id', 'patient_id', 'label', 'address_text', 'version', 'created_by', 'updated_by'], defaults: { version: 1, is_active: true }, unique: [['id'], ['tenant_id', 'id']],
  }),
  payment_requests: T(['id', 'tenant_id', 'account_id', 'order_id', 'patient_id', 'gateway', 'status', 'review', 'intent_id', 'amount_paisa', 'action_json', 'failure_code', 'idempotency_key', 'expires_at', ...AUDIT_COLS], {
    notNull: ['id', 'tenant_id', 'account_id', 'order_id', 'patient_id', 'gateway', 'status', 'idempotency_key', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'queued', review: false, intent_id: null, amount_paisa: null, action_json: null, failure_code: null, expires_at: null, version: 1, is_active: true }, unique: [['id'], ['tenant_id', 'id']],
    check: (r) => (!['esewa', 'khalti'].includes(r['gateway']) ? 'payment_requests__gateway__ck'
      : !['queued', 'ready', 'completed', 'failed', 'expired'].includes(r['status']) ? 'payment_requests__status__ck'
      : r['status'] !== 'ready' && has(r['action_json']) ? 'payment_requests__action__ck' // the secret-bearing URL is scrubbed when leaving 'ready'
      : r['status'] === 'ready' && !(has(r['intent_id']) && has(r['amount_paisa'])) ? 'payment_requests__ready__ck' : undefined),
  }),
  // lab records: the deletion must not write to these (TRD §4.14 "Bookings stay ... Enquiry threads stay readable by staff"; PRD US-EN-19.1 "lab records in C4/C5/C6 are untouched")
  bookings: T(['id', 'tenant_id', 'account_id', 'patient_id', 'booking_no', 'status', 'version', 'updated_at'], { unique: [['id']] }),
  reminders: T(['id', 'tenant_id', 'patient_id', 'kind', 'status', 'due_at', 'version', 'updated_at'], { unique: [['id']] }),
  enquiries: T(['id', 'tenant_id', 'account_id', 'status', 'version', 'updated_at'], { unique: [['id']] }),
});

const OWN_COL: Record<string, string> = { accounts: 'id', account_patient_links: 'account_id', addresses: 'account_id', payment_requests: 'account_id', bookings: 'account_id', enquiries: 'account_id', reminders: '' };
const LINK_ALLOWED = new Set(['relationship', 'status', 'revoked_by_kind', 'revoked_reason_code', 'revoked_at', 'is_active', 'updated_at', 'updated_by', 'version']);

const acct = (id: string, mem: string, phone: string, hmac: Buffer, tenant = TA, over: Row = {}): Row => ({ id, tenant_id: tenant, membership_id: mem, user_id: ID(0xf0), phone_e164: phone, phone_hmac: hmac, status: 'active', reminders_opt_out: false,
  last_login_at: T0, last_app_platform: 'android', last_app_version: '1.4.0', deleted_at: null, version: 1, is_active: true, created_at: '2026-10-01T00:00:00.000Z', created_by: mem, updated_at: '2026-10-01T00:00:00.000Z', updated_by: mem, ...over });
const lnk = (id: string, account: string, patient: string, over: Row = {}, tenant = TA): Row => ({ id, tenant_id: tenant, account_id: account, patient_id: patient, relationship: 'other', method: 'report_link', link_code_id: null, consent_id: null, display_name: 'Synthetic Linked',
  sex_snapshot: null, status: 'active', suspend_reason: null, suspended_at: null, visible_from: '2026-10-01T00:00:00.000Z', record_phone_hmac_at_link: HMAC1, revoked_by_kind: null, revoked_reason_code: null, revoked_at: null, version: 1, is_active: true,
  created_at: '2026-10-02T00:00:00.000Z', created_by: MEM1, updated_at: '2026-10-02T00:00:00.000Z', updated_by: MEM1, ...over });
const pr = (id: string, account: string, patient: string, status: string, over: Row = {}, tenant = TA): Row => ({ id, tenant_id: tenant, account_id: account, order_id: ID(0x0d0), patient_id: patient, gateway: 'esewa', status, review: false,
  intent_id: status === 'ready' ? ID(0x1d1) : null, amount_paisa: status === 'ready' ? 150000 : null, action_json: status === 'ready' ? { kind: 'redirect', url: 'https://pay.invalid/secret-token' } : null, failure_code: status === 'failed' ? 'gateway_error' : null,
  idempotency_key: `k-${id}`, expires_at: '2026-11-06T00:00:00.000Z', version: 1, is_active: true, created_at: '2026-11-01T00:00:00.000Z', created_by: MEM1, updated_at: '2026-11-01T00:00:00.000Z', updated_by: MEM1, ...over });
const adr = (id: string, account: string, patient: string, over: Row = {}, tenant = TA): Row => ({ id, tenant_id: tenant, account_id: account, patient_id: patient, label: 'home', address_text: 'Test Street 9, Test Ward 9', landmark: null, municipality: null, ward_no: null,
  district: null, latitude: null, longitude: null, contact_phone_e164: null, version: 1, is_active: true, created_at: '2026-10-05T00:00:00.000Z', created_by: MEM1, updated_at: '2026-10-05T00:00:00.000Z', updated_by: MEM1, ...over });

export function seedTables(): Record<string, Row[]> {
  return {
    patients: [{ id: PAT1, tenant_id: TA }, { id: PAT2, tenant_id: TA }, { id: PATB, tenant_id: TB }],
    settings: [],
    accounts: [acct(ACC1, MEM1, PHONE1, HMAC1, TA, { version: V1, reminders_opt_out: false }), acct(ACC2, MEM2, PHONE2, HMAC2), acct(ACCB, MEMB, PHONEB, HMACB, TB, { version: 5 })],
    account_patient_links: [
      lnk(L_ACTIVE, ACC1, PAT1, { relationship: 'self', method: 'link_code', link_code_id: ID(0x1c1) }),
      lnk(L_ACTIVE2, ACC1, PAT2, { relationship: 'child' }), // active here; the suspended-link variant is `suspendLink` (blocked by .orchestra/cr/T-AC1.md)
      lnk(L_REVOKED, ACC1, ID(0x93), { status: 'revoked', revoked_by_kind: 'staff', revoked_reason_code: 'suspected_misuse', revoked_at: REVOKED_EARLIER, is_active: false }), // an earlier staff revoke must keep its own reason
      lnk(L_A2, ACC2, PAT1, { relationship: 'parent' }), // another account linked to the SAME patient: untouched by A1's deletion
      lnk(L_B, ACCB, PATB, {}, TB),
    ],
    addresses: [adr(AD_1, ACC1, PAT1), adr(AD_2, ACC1, PAT2, { label: 'work' }), adr(AD_OLD, ACC1, PAT1, { label: 'other', is_active: false }), adr(AD_A2, ACC2, PAT1), adr(AD_B, ACCB, PATB, {}, TB)],
    payment_requests: [pr(PR_QUEUED, ACC1, PAT1, 'queued'), pr(PR_READY, ACC1, PAT1, 'ready'), pr(PR_DONE, ACC1, PAT1, 'completed'), pr(PR_FAILED, ACC1, PAT1, 'failed'), pr(PR_A2, ACC2, PAT1, 'queued'), pr(PR_B, ACCB, PATB, 'queued', {}, TB)],
    bookings: [{ id: BK1, tenant_id: TA, account_id: ACC1, patient_id: PAT1, booking_no: 'BK-2611-000001', status: 'confirmed', version: 1, updated_at: '2026-11-01T00:00:00.000Z' }],
    reminders: [{ id: RM1, tenant_id: TA, patient_id: PAT1, kind: 'booking', status: 'scheduled', due_at: '2026-11-20T00:00:00.000Z', version: 1, updated_at: '2026-11-01T00:00:00.000Z' }],
    enquiries: [{ id: EQ1, tenant_id: TA, account_id: ACC1, status: 'open', version: 1, updated_at: '2026-11-01T00:00:00.000Z' }],
  };
}

export type Who = 'patient' | 'system' | 'user';
export interface InvokeOpts { account?: string; who?: Who; tenant?: string; ctx?: Record<string, unknown> }

export function makeAccountWorld(o: { seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: T0 };
  const tables = seedTables();
  o.seed?.({ tables });
  const pristine = deep(tables) as Record<string, Row[]>;
  const db = new FakeDb(tables, defs(), clock);
  const events: string[] = [];
  const logs: unknown[] = [];
  const audit = { access: [] as any[], event: [] as any[] };
  const foreign = { touches: 0 };
  const inject = { failOn: undefined as undefined | RegExp };

  const grants = new Set<string>(['engagement.self.manage', 'engagement.self.read']);
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, deny: new Set<string>(),
    revokes: [] as Array<{ actorType: string; actorId: unknown; tenantId: unknown; input: any }>,
    failRevoke: undefined as undefined | (() => unknown),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
    async revokePatientSessions(ctx: any, input: any) {
      identity.revokes.push({ actorType: ctx?.actor?.type, actorId: ctx?.actor?.id, tenantId: ctx?.tenantId, input: deep(input) }); events.push('revoke');
      if (identity.failRevoke) throw identity.failRevoke();
      return { revokedSessions: 2 };
    },
  };

  const ctxFor = makeCtxFor();
  const commit = { requested: false };
  const build = (who: Who, account: string, tenant: string, over: Record<string, unknown>) => {
    const s = db.session(tenant, { all: true, centres: [] }, who === 'system' ? SYSTEM : who === 'user' ? STAFF : MEM1);
    const membership = () => tables['accounts']!.find((a) => a['id'] === account)?.['membership_id'] ?? MEM1;
    const tx = {
      async query(text: string, values: unknown[] = []) {
        events.push(`stmt:${text}`);
        if (inject.failOn?.test(text)) throw new Error('injected database failure');
        const verb = /^\s*(select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase();
        const tbl = (/\b(?:from|into|update)\s+(?:engagement\.)?(\w+)/i.exec(text) ?? [])[1] as string;
        const before = verb === 'update' && who === 'patient' && tbl && tables[tbl] ? deep(tables[tbl]) as Row[] : undefined;
        const res: any = await s.tx.query(text, values);
        if (who === 'patient' && tbl && tbl in OWN_COL) {
          const col = OWN_COL[tbl]!;
          // addresses UPDATE = PAT_ACC_PID (05-SCHEMA l.1336/1361): own account AND patient_id among the patients of the account's ACTIVE links (app.engagement_patient_ids()), evaluated against the links as they are NOW.
          // A row outside that set is silently filtered (0 rows, no error): revoking the links before updating addresses leaves every address active. (INSERT is not emulated: T-AC1 never inserts addresses.)
          const reach = (r: Row) => tbl !== 'addresses' || tables['account_patient_links']!.some((l) => l['account_id'] === account && l['status'] === 'active' && l['patient_id'] === r['patient_id']);
          const mine = (r: Row) => (col ? r[col] === account : false);
          if (verb === 'select' && !/^\s*select\s+count\(\*\)/i.test(text)) { res.rows = res.rows.filter((r: Row) => mine(r)); res.rowCount = res.rows.length; }
          if (verb === 'insert' && tbl === 'accounts') { tables[tbl]!.pop(); throw Object.assign(new Error('new row violates row-level security policy (accounts: INSERT is pre-auth only)'), { code: '42501' }); }
          if (before) {
            const rows = tables[tbl]!;
            rows.forEach((r, i) => { // RLS USING: the statement could only have reached own rows
              if (JSON.stringify(r) === JSON.stringify(before[i])) return;
              const own = mine(before[i]!);
              if (!own || !reach(before[i]!)) { if (!own) foreign.touches++; for (const k of Object.keys(r)) r[k] = before[i]![k]; res.rowCount = Math.max(0, (res.rowCount ?? 0) - 1); }
            });
            if (tbl === 'account_patient_links') {
              rows.forEach((r, i) => {
                const b = before[i]!; const changed = Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(b[k]));
                // No tolerance for suspend_reason/suspended_at: the real guard rejects them even when links__suspend__ck forces them NULL on suspended -> revoked (review T-AC1 item 2; CR pending).
                const ok = (k: string) => LINK_ALLOWED.has(k);
                if (changed.some((k) => !ok(k)) || (changed.includes('status') && r['status'] !== 'revoked')) {
                  for (const k of Object.keys(r)) r[k] = b[k];
                  throw Object.assign(new Error('immutable_row'), { code: 'P0001', detail: 'engagement.account_patient_links' });
                }
              });
            }
          }
        }
        if (verb === 'insert' && tbl === 'accounts' && res.rowCount > 0) { // the partial unique indexes of 05-SCHEMA §3
          const rows = tables['accounts']!; const row = rows[rows.length - 1]!;
          const undo = (c: string) => { rows.pop(); throw Object.assign(new Error(`violates ${c}`), { code: '23505', constraint: c }); };
          if (row['status'] === 'active' && rows.some((r) => r !== row && r['tenant_id'] === row['tenant_id'] && r['status'] === 'active' && r['phone_e164'] === row['phone_e164'])) undo('accounts__tenant_id_phone_e164__p_uq');
          if (row['status'] === 'active' && rows.some((r) => r !== row && r['tenant_id'] === row['tenant_id'] && r['status'] === 'active' && Buffer.from(r['phone_hmac']).equals(Buffer.from(row['phone_hmac'])))) undo('accounts__tenant_id_phone_hmac__p_uq');
        }
        return res;
      },
    };
    const base: any = ctxFor(`${tenant === TB ? 'B' : 'A'}:${who}`, { tx: tx as never, now: () => clock.iso, ports: { IdentityPort: identity } as never });
    const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a), child() { return log; } };
    const ctx: any = { ...base, actor: { type: who, id: who === 'system' ? SYSTEM : who === 'user' ? STAFF : membership() }, claims: { membership_id: membership(), actor_type: who },
      audit: { access: async (e: unknown) => { audit.access.push(deep(e)); events.push('audit'); }, event: async (e: unknown) => { audit.event.push(deep(e)); } },
      clientIp: '203.0.113.9', log, metrics: { inc() {}, set() {}, observe() {} }, commitOnError() { commit.requested = true; }, rateLimit: { async consume() {} }, ...over };
    return { ctx, release: s.release };
  };

  /** One transaction like the core pipeline: DB state + audit roll back when `f` throws, unless commitOnError() was requested. */
  async function inTx<T>(f: () => Promise<T>): Promise<T> {
    const snap = deep(tables) as Record<string, Row[]>; const auditN = [audit.access.length, audit.event.length]; commit.requested = false;
    try { return await f(); } catch (e) {
      if (!commit.requested) { for (const k of Object.keys(tables)) tables[k]!.splice(0, tables[k]!.length, ...snap[k]!); audit.access.length = auditN[0]!; audit.event.length = auditN[1]!; }
      throw e;
    }
  }
  /** One request of a patient session (account default A1, tenant A): fresh ctx and DB session, in a transaction; the session's row locks are released afterwards. */
  async function invoke<T>(f: (ctx: any) => Promise<T>, opts: InvokeOpts = {}): Promise<T> {
    const { ctx, release } = build(opts.who ?? 'patient', opts.account ?? ACC1, opts.tenant ?? TA, { operationId: 'deleteMyAccount', ...opts.ctx });
    try { return await inTx(() => f(ctx)); } finally { release(); }
  }

  const row = (table: string, id: string): Row | undefined => tables[table]!.find((r) => r['id'] === id);
  return {
    db, tables, clock, logs, audit, events, identity, grants, inject, foreign, invoke, inTx, commit,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    /** Engagement tables a write statement names (to prove the deletion touches only the four account-owned tables). */
    writtenTables: () => [...new Set(db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)).map((c) => (/\b(?:into|update)\s+(?:engagement\.)?(\w+)/i.exec(c.text) ?? [])[1]!))].sort(),
    row, account: (id = ACC1) => row('accounts', id)!, link: (id: string) => row('account_patient_links', id)!, payment: (id: string) => row('payment_requests', id)!, address: (id: string) => row('addresses', id)!,
    /** The seed as it was before any request (deep copy) - for "untouched" assertions. */
    pristine, snapshot: (table: string): Row[] => deep(tables[table]) as Row[],
    reset: () => { for (const k of Object.keys(tables)) tables[k]!.splice(0, tables[k]!.length, ...(deep(pristine[k]) as Row[])); },
  };
}
export type AccountWorld = ReturnType<typeof makeAccountWorld>;
