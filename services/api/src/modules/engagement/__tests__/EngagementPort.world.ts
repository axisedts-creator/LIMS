// C16.T-EP1 test world (tester-owned): engagement.addresses + membership_plans + patient_memberships on the shared FakeDb SQL interpreter (fakeSql.ts),
// a fake IdentityPort.assertRole, and ctx spies for audit.access / log. Used by EngagementPort.impl.test.ts, which also feeds the shared
// packages/fakes/contract-tests/EngagementPort.contract.ts through `contractHarness()`.
// Grammar limit (fakeSql.ts): single-table statements only (no JOIN, no sub-select); anything else throws `fake-sql: unsupported ...`, so the impl must read
// patient_memberships and membership_plans with separate statements (as membership.repo.ts does). Tenant RLS is modelled by the FakeDb session; `bypassRls`
// hands the ctx a transaction whose RLS belongs to ANOTHER tenant, to prove the impl also binds tenant_id itself (REQ-SEC-024).
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { FakeDb, type Row, type TableDef } from './fakeSql.js';
import { ID, membership, membershipSchemaDefs, plan } from './membership.world.js';

export const TA: string = TENANTS.A;
export const TB: string = TENANTS.B;
export const PERM = { REG: 'frontdesk.registration.create', VISIT_ASSIGN: 'homecollection.visit.assign', VISIT_READ: 'homecollection.visit.read' } as const;
export const ALL_GRANTS = [PERM.REG, PERM.VISIT_ASSIGN, PERM.VISIT_READ] as const;
export const NOW = '2026-11-05T04:15:00.000Z';

const T = (columns: string[], more: Partial<TableDef> = {}): TableDef => ({ columns, ...more });
const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  membership_plans: membershipSchemaDefs(clock)['membership_plans']!,
  patient_memberships: membershipSchemaDefs(clock)['patient_memberships']!,
  addresses: T(['id', 'tenant_id', 'account_id', 'patient_id', 'label', 'address_text', 'landmark', 'municipality', 'ward_no', 'district', 'latitude', 'longitude', 'contact_phone_e164', 'version', 'is_active',
    'created_at', 'created_by', 'updated_at', 'updated_by'], { notNull: ['id', 'tenant_id', 'patient_id', 'label', 'address_text'], unique: [['id'], ['tenant_id', 'id']] }),
});

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ADDR1 =ID(0xad1), ADDR2 = ID(0xad2), ADDR_NO_GEO = ID(0xad3), ADDR_B = ID(0xadb);
export const PAT_HOME = ID(0x91), PAT_HOME_B = ID(0x9b);
export const address = (o: Row = {}): Row => ({ id: ADDR1, tenant_id: TA, account_id: null, patient_id: PAT_HOME, label: 'home', address_text: 'Test Street 9, Test Ward 9', landmark: 'Next to the synthetic pharmacy',
  municipality: 'Test Municipality', ward_no: 9, district: 'Test District', latitude: '27.717200', longitude: '85.324000', contact_phone_e164: '+97798000000099', version: 1, is_active: true,
  created_at: '2026-10-01T00:00:00.000Z', created_by: ID(0x5f), updated_at: '2026-10-01T00:00:00.000Z', updated_by: ID(0x5f), ...o });

export interface EpWorldOpts { now?: string; seed?: (w: { tables: Record<string, Row[]> }) => void; grants?: readonly string[] }

export function makeEpWorld(o: EpWorldOpts = {}) {
  const clock = { iso: o.now ?? NOW };
  const tables: Record<string, Row[]> = {
    membership_plans: [plan(), plan({ id: ID(0x2b), tenant_id: TB, code: 'GOLD', display_name: 'Tenant B plan (synthetic)' })],
    patient_memberships: [],
    addresses: [
      address(), address({ id: ADDR2, address_text: 'Test Lane 2, Test Ward 2', landmark: 'Opposite the synthetic school' }),
      address({ id: ADDR_NO_GEO, address_text: 'Test Road 3, Test Ward 3', landmark: null, latitude: null, longitude: null }),
      address({ id: ADDR_B, tenant_id: TB, patient_id: PAT_HOME_B, address_text: 'Tenant B Street 1, Test Ward 1' }),
    ],
  };
  o.seed?.({ tables });
  const db = new FakeDb(tables, defs(clock), clock);
  const audit = { access: [] as unknown[], event: [] as unknown[] };
  const logged: unknown[][] = [];
  const grants = new Set<string>(o.grants ?? ALL_GRANTS);
  const identity = {
    asserted: [] as Array<{ permission: string; at: number }>,
    async assertRole(_ctx: unknown, r: { permission: string }) {
      identity.asserted.push({ permission: r?.permission, at: db.calls.length });
      if (!grants.has(r?.permission)) throw new LimsError('auth.forbidden');
    },
  };
  const ctxFor = makeCtxFor();
  /** key grammar of harness.ctxFor: 'A' | 'B' | '<A|B>:<actorType>'. `bypassRls`: the tx carries the RLS of tenant A while ctx.tenantId is B. */
  const ctx = (key = 'A', over: Record<string, unknown> = {}, opt: { bypassRls?: boolean } = {}): any => {
    const tenant = key.startsWith('B') ? TB : TA;
    const s = db.session(opt.bypassRls ? TA : tenant, { all: true, centres: [] });
    const log = { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a), debug: (...a: unknown[]) => logged.push(a), child() { return this; } };
    return ctxFor(key, { tx: s.tx as never, now: () => clock.iso, ports: { IdentityPort: identity } as never,
      audit: { access: async (e: unknown) => { audit.access.push(e); }, event: async (e: unknown) => { audit.event.push(e); } },
      log, operationId: 'x', requestId: '01900000-0000-7000-8000-0000000000e1', metrics: { inc() {}, set() {}, observe() {} }, ...over } as never);
  };
  return {
    db, tables, clock, identity, audit, grants, ctx, logged,
    get stmts() { return db.calls; },
    writes: () => db.calls.filter((c) => /^\s*(insert|update|delete)\b/i.test(c.text)),
    advance(ms: number) { clock.iso = new Date(Date.parse(clock.iso) + ms).toISOString(); },
  };
}
export type EpWorld = ReturnType<typeof makeEpWorld>;

/** ContractHarness (packages/fakes/src/harness.ts) over the real impl: fixtures of EngagementPort.contract.ts are translated into table rows. */
export function contractHarness(impl: unknown): () => Promise<ContractHarness> {
  return async () => {
    const w = makeEpWorld();
    w.tables['membership_plans'] = []; w.tables['addresses'] = []; w.tables['patient_memberships'] = [];
    let seq = 0;
    return {
      impl,
      events: createEventSpy(),
      ctxFor: (key, over) => w.ctx(key, over as Record<string, unknown>),
      async seed(fx: any) {
        for (const m of fx.memberships ?? []) {
          let p = w.tables['membership_plans']!.find((r) => r['tenant_id'] === m.tenantId && r['code'] === m.planCode && r['display_name'] === m.planName);
          if (!p) { p = plan({ id: ID(0x4000 + ++seq), tenant_id: m.tenantId, code: m.planCode, display_name: m.planName, price_list_id: m.priceListId ?? ID(0x7ff) }); w.tables['membership_plans']!.push(p); }
          w.tables['patient_memberships']!.push(membership({ id: m.membershipId, tenant_id: m.tenantId, patient_id: m.patientId, plan_id: p['id'], status: m.status,
            card_no: `MB${String(26000000 + ++seq)}`, card_token: `0123456789ABCDEFGHJKMNPQ${CROCKFORD[seq % 32]}${CROCKFORD[(seq >> 5) % 32]}`,
            valid_from: String(m.validFrom).slice(0, 10), valid_to: String(m.validTo).slice(0, 10) }));
        }
        for (const a of fx.homeAddresses ?? []) w.tables['addresses']!.push(address({ id: a.id, tenant_id: a.tenantId, address_text: a.addressText, landmark: null, latitude: null, longitude: null }));
      },
      rollback() {},
    };
  };
}
