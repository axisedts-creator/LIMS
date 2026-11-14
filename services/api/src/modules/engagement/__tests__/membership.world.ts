// C16.T-M1 test world (tester-owned): membership tables on the shared FakeDb SQL interpreter (fakeSql.ts) + fakes for IdentityPort.assertRole,
// CatalogPort.getPriceListStatus (CR-C16-023 / 08 A24.1) and ctx.audit.access. Used by membership.handlers.test.ts and the worker's expire_memberships.test.ts.
// Grammar limit (fakeSql.ts): single-table statements only (no JOIN, no sub-select); anything else throws `fake-sql: unsupported ...` so a mismatch is loud.
// Models: tenant RLS (STAFF), PAT_ACC / PAT_PID for a patient actor (05-SCHEMA §8: account_patient_links by account, patient_memberships by the patients of the
// account's ACTIVE links), UNIQUE / NOT NULL / FK / CHECK of 05-SCHEMA §2 membership_plans + patient_memberships + number_counters, and the PARTIAL unique index
// patient_memberships__tenant_id_patient_active__p_uq (one active membership per (tenant, patient)) -> pg 23505 with that constraint name.
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const PRIVILEGED = new Set(['engagement.membership_plan.manage']); // contracts/permissions.yaml (aal2)
export const P = { PLAN_MANAGE: 'engagement.membership_plan.manage', ENROL: 'engagement.membership.enrol', READ: 'engagement.membership.read', SELF: 'engagement.self.read' } as const;

export const PL_PUBLISHED = ID(0x701), PL_DRAFT = ID(0x702), PL_INACTIVE = ID(0x703), PL_UNKNOWN = ID(0x704), PL_DISCARDED = ID(0x705);
export const PAT1 = ID(0x11), PAT2 = ID(0x12), PAT3 = ID(0x13), PAT_B = ID(0x1b);
export const PLAN_GOLD = ID(0x21), PLAN_OLD = ID(0x22), PLAN_B = ID(0x2b);
export const ACC1 = ID(0xa1), ACC2 = ID(0xa2), LINK1 = ID(0xc1), LINK2 = ID(0xc2), LINK_REVOKED = ID(0xc3), LINK_ACC2 = ID(0xc4);
export const STAFF = ID(0x5f), SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // 05-SCHEMA patient_memberships__card__ck (Crockford base32, no I L O U)
export const TOKEN_OK = '0123456789ABCDEFGHJKMNPQRS', TOKEN_B = '7ZZZZZZZZZZZZZZZZZZZZZZZZ7';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });

export const membershipSchemaDefs = (clock: { iso: string }): Record<string, TableDef> => ({
  membership_plans: T(['id', 'tenant_id', 'code', 'display_name', 'description', 'price_list_id', 'validity_days', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
    notNull: ['id', 'tenant_id', 'code', 'display_name', 'price_list_id', 'validity_days', 'created_by', 'updated_by'],
    defaults: { version: 1, is_active: true, description: null },
    unique: [['id'], ['tenant_id', 'id'], ['tenant_id', 'code']],
    check: (r) => (!/^[A-Z0-9_]{2,20}$/.test(r['code']) ? 'membership_plans__code__ck'
      : !(String(r['display_name']).length >= 1 && String(r['display_name']).length <= 60 && (r['description'] == null || String(r['description']).length <= 300)) ? 'membership_plans__name__ck'
      : !(r['validity_days'] >= 30 && r['validity_days'] <= 1095) ? 'membership_plans__validity__ck' : undefined),
  }),
  patient_memberships: T(['id', 'tenant_id', 'patient_id', 'plan_id', 'card_no', 'card_token', 'status', 'valid_from', 'valid_to', 'enrolled_by', 'enrolled_centre_id', 'cancelled_at', 'cancel_reason_code', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
    notNull: ['id', 'tenant_id', 'patient_id', 'plan_id', 'card_no', 'card_token', 'status', 'valid_from', 'valid_to', 'enrolled_by', 'created_by', 'updated_by'],
    defaults: { status: 'active', version: 1, is_active: true, cancelled_at: null, cancel_reason_code: null, enrolled_centre_id: null },
    unique: [['id'], ['tenant_id', 'id'], ['tenant_id', 'card_no'], ['tenant_id', 'card_token']],
    fk: [{ cols: ['tenant_id', 'patient_id'], ref: 'patients', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'plan_id'], ref: 'membership_plans', refCols: ['tenant_id', 'id'] }],
    check: (r) => (!['active', 'cancelled', 'expired'].includes(r['status']) ? 'patient_memberships__status__ck'
      : !(iso(r['valid_to']) > iso(r['valid_from'])) ? 'patient_memberships__dates__ck'
      : (r['status'] === 'cancelled') !== (r['cancelled_at'] != null && r['cancel_reason_code'] != null) ? 'patient_memberships__cancel__ck'
      : r['cancel_reason_code'] != null && !['patient_request', 'staff_error', 'other'].includes(r['cancel_reason_code']) ? 'patient_memberships__cancel_reason__ck'
      : !(/^MB[0-9]{8}$/.test(r['card_no']) && TOKEN_RE.test(r['card_token'])) ? 'patient_memberships__card__ck' : undefined),
  }),
  number_counters: T(['tenant_id', 'counter_key', 'last_value', 'expires_at', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
    notNull: ['tenant_id', 'counter_key', 'last_value'], defaults: { last_value: 0, expires_at: null }, unique: [['tenant_id', 'counter_key']],
    check: (r) => (/^(booking_no|card_no):[0-9]{2}$|^otp_day:[0-9]{8}$|^linkfail:[0-9a-f-]{36}:[0-9]{10}$/.test(r['counter_key']) ? undefined : 'number_counters__key__ck'),
  }),
  accounts: T(['id', 'tenant_id', 'membership_id', 'status'], { unique: [['id']] }),
  account_patient_links: T(['id', 'tenant_id', 'account_id', 'patient_id', 'display_name', 'relationship', 'status', 'version'], { unique: [['id']] }),
  patients: T(['id', 'tenant_id'], { unique: [['id']] }),
});

export type Plan = Row;
export const plan = (o: Row = {}): Row => ({ id: PLAN_GOLD, tenant_id: TA, code: 'GOLD', display_name: 'Gold plan (synthetic)', description: null, price_list_id: PL_PUBLISHED, validity_days: 365, version: 1, is_active: true,
  created_at: '2026-10-01T00:00:00.000Z', created_by: STAFF, updated_at: '2026-10-01T00:00:00.000Z', updated_by: STAFF, ...o });
export const membership = (o: Row = {}): Row => ({ id: ID(0x301), tenant_id: TA, patient_id: PAT1, plan_id: PLAN_GOLD, card_no: 'MB26000001', card_token: TOKEN_OK, status: 'active', valid_from: '2026-10-01', valid_to: '2027-10-01',
  enrolled_by: STAFF, enrolled_centre_id: null, cancelled_at: null, cancel_reason_code: null, version: 1, is_active: true, created_at: '2026-10-01T00:00:00.000Z', created_by: STAFF, updated_at: '2026-10-01T00:00:00.000Z', updated_by: STAFF, ...o });

export interface Catalog { calls: unknown[]; lists: Record<string, { isActive: boolean; status: string } | 'not_found' | 'error'>; port: { getPriceListStatus(ctx: unknown, input: { priceListId: string }): Promise<unknown> } }
function catalogFake(): Catalog {
  const c: Catalog = {
    calls: [],
    lists: { [PL_PUBLISHED]: { isActive: true, status: 'published' }, [PL_DRAFT]: { isActive: true, status: 'draft' }, [PL_INACTIVE]: { isActive: false, status: 'published' }, [PL_DISCARDED]: { isActive: true, status: 'discarded' } }, // PL_UNKNOWN absent
    port: {
      async getPriceListStatus(ctx: any, input: { priceListId: string }) {
        c.calls.push({ ctx, input });
        const l = c.lists[input?.priceListId];
        if (!l || l === 'not_found') throw new LimsError('common.not_found');
        if (l === 'error') throw new LimsError('common.dependency_unavailable'); // not service_unavailable: that is the T-01 placeholder's code
        return { priceListId: input.priceListId, ...l };
      },
    },
  };
  return c;
}

export function makeWorld(o: { now?: string; tenant?: string; seed?: (w: { tables: Record<string, Row[]> }) => void } = {}) {
  const clock = { iso: o.now ?? '2026-11-05T04:15:00.000Z' }; // 09:55 on 2026-11-05 in Asia/Kathmandu
  const tables: Record<string, Row[]> = {
    membership_plans: [plan(), plan({ id: PLAN_OLD, code: 'OLD', display_name: 'Retired plan (synthetic)', is_active: false }), plan({ id: PLAN_B, tenant_id: TB, code: 'GOLD', display_name: 'Tenant B plan', price_list_id: PL_PUBLISHED })],
    patient_memberships: [], number_counters: [],
    patients: [{ id: PAT1, tenant_id: TA }, { id: PAT2, tenant_id: TA }, { id: PAT3, tenant_id: TA }, { id: PAT_B, tenant_id: TB }],
    accounts: [{ id: ACC1, tenant_id: TA, membership_id: ID(0xe1), status: 'active' }, { id: ACC2, tenant_id: TA, membership_id: ID(0xe2), status: 'active' }],
    account_patient_links: [
      { id: LINK1, tenant_id: TA, account_id: ACC1, patient_id: PAT1, display_name: 'Synthetic Patient One', relationship: 'self', status: 'active', version: 1 },
      { id: LINK_REVOKED, tenant_id: TA, account_id: ACC1, patient_id: PAT3, display_name: 'Synthetic Patient Three', relationship: 'child', status: 'revoked', version: 2 },
      { id: LINK_ACC2, tenant_id: TA, account_id: ACC2, patient_id: PAT2, display_name: 'Synthetic Patient Two', relationship: 'self', status: 'active', version: 1 },
    ],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, membershipSchemaDefs(clock), clock);
  const catalog = catalogFake();
  const audit = { access: [] as any[], event: [] as any[] };
  const grants = new Set<string>(Object.values(P));
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>, aal: 2 as 1 | 2, deny: new Set<string>(),
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (identity.deny.has(r?.permission) || !grants.has(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && identity.aal < 2) throw new LimsError('auth.mfa_required');
    },
  };
  const ctxFor = makeCtxFor();
  /** actor 'staff' (user) | 'patient:<accountKey>' (PAT_ACC/PAT_PID) | 'system'. Tenant = A unless `tenant` is B. */
  const session = (who: 'staff' | 'system' | 'patient' = 'staff', over: Record<string, unknown> = {}, tenant = o.tenant ?? TA, account = ACC1) => {
    const s = db.session(tenant, { all: true, centres: [] }, who === 'system' ? SYSTEM : STAFF);
    const patientIds = () => new Set(tables['account_patient_links']!.filter((l) => l['tenant_id'] === tenant && l['account_id'] === account && l['status'] === 'active').map((l) => l['patient_id']));
    const tx = {
      async query(text: string, values: unknown[] = []) {
        const res: any = await s.tx.query(text, values);
        const tbl = /\bfrom\s+(?:engagement\.)?(\w+)/i.exec(text)?.[1];
        if (who === 'patient' && /^\s*select/i.test(text)) {
          if (tbl === 'account_patient_links') res.rows = res.rows.filter((r: Row) => r['account_id'] === account);
          if (tbl === 'patient_memberships') res.rows = res.rows.filter((r: Row) => patientIds().has(r['patient_id']));
          if (tbl === 'accounts') res.rows = res.rows.filter((r: Row) => r['id'] === account);
          res.rowCount = res.rows.length;
        }
        if (/^\s*insert\s+into\s+(?:engagement\.)?patient_memberships/i.test(text) && res.rowCount > 0) { // the partial unique index (status = 'active')
          const rows = tables['patient_memberships']!, mine = rows[rows.length - 1]!;
          if (mine['status'] === 'active' && rows.some((r) => r !== mine && r['tenant_id'] === mine['tenant_id'] && r['patient_id'] === mine['patient_id'] && r['status'] === 'active')) {
            rows.pop();
            throw Object.assign(new Error('duplicate key value violates unique constraint "patient_memberships__tenant_id_patient_active__p_uq"'), { code: '23505', constraint: 'patient_memberships__tenant_id_patient_active__p_uq' });
          }
        }
        return res;
      },
    };
    const actorId = who === 'patient' ? tables['accounts']!.find((a) => a['id'] === account)!['membership_id'] : who === 'system' ? SYSTEM : STAFF;
    const tenantKey = tenant === TB ? 'B' : 'A';
    const base: any = ctxFor(`${tenantKey}:${who === 'staff' ? 'user' : who}`, { tx: tx as never, now: () => clock.iso, ports: { IdentityPort: identity, CatalogPort: catalog.port } as never });
    return { ...base, actor: { type: who === 'staff' ? 'user' : who, id: actorId }, audit: { access: async (e: unknown) => { audit.access.push(e); }, event: async (e: unknown) => { audit.event.push(e); } },
      operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} }, ...over } as any;
  };
  return {
    db, tables, clock, catalog, identity, audit, grants, session,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    advance(ms: number) { clock.iso = new Date(Date.parse(clock.iso) + ms).toISOString(); },
    mem: (id: string) => tables['patient_memberships']!.find((m) => m['id'] === id),
  };
}
export type World = ReturnType<typeof makeWorld>;
