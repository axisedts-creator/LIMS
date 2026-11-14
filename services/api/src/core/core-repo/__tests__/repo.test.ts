// T0D-08 ctx.core read-only repository (02-TRD §6.8): tenant-filtered reads, widened memberships.list / MembershipRow (08 A17 D-47,
// AC-0D-6.5), CentreRow.phoneDisplay (C4 hand-off). REQ-SEC-024: every query filters tenant_id explicitly in addition to RLS.
// Contract assumed: core-repo/index.ts createCoreRepo({ withTenantScope, systemActorOf, log?, metrics? }) -> CoreRepository.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../errors.js';
import { createCoreRepo } from '../index.js';
import { TENANT_A, TENANT_B, idN, rejection, systemActorOf } from './helpers.js';

const CENTRE = idN(0xc1); const CENTRE2 = idN(0xc2); const BRANCH = idN(0xb1);
const MEM = idN(0x3001); const USER = idN(0x4001);
const STAFF = { type: 'user', id: USER, membershipId: MEM };

const ROWS = {
  tenant: { id: TENANT_A, tenant_code: 'demo-lab', display_name: 'Demo Lab', legal_name: 'Demo Laboratories Pvt Ltd', status: 'active', timezone: 'Asia/Kathmandu' },
  branch: { id: BRANCH, branch_code: 'KTM', name: 'Kathmandu Main', address_text: 'Synthetic Road 1', phone_display: '01-4400000', is_processing_lab: true, is_active: true },
  centre: { id: CENTRE, branch_id: BRANCH, centre_code: 'C-01', name: 'Baneshwor Centre', centre_kind: 'own', address_text: 'Synthetic Chowk 2', phone_display: '01-4411111', is_active: true },
  user: { id: USER, display_name: 'Synthetic Staff', is_active: true },
  membership: {
    id: MEM, membership_id: MEM, user_id: USER, actor_type: 'user', display_name: 'Synthetic Staff', status: 'active', is_active: true,
    locked_at: null as Date | null, all_centres: false, centre_ids: [CENTRE, CENTRE2], role_codes: ['lab_tech', 'phlebotomist'],
  },
};

function setup(over: Partial<Record<keyof typeof ROWS, Record<string, unknown> | null>> = {}) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const answer = (text: string): unknown[] => {
    if (/role_permissions/i.test(text) && !/display_name|all_centres/i.test(text)) return [{ permission_code: 'lab.result.read' }, { permission_code: 'lab.result.enter' }];
    const pick = (k: keyof typeof ROWS) => (over[k] === null ? [] : [{ ...ROWS[k], ...(over[k] ?? {}) }]);
    if (/core\.collection_centres/i.test(text)) return pick('centre');
    if (/core\.branches/i.test(text)) return pick('branch');
    if (/core\.tenants/i.test(text)) return pick('tenant');
    if (/core\.memberships\b/i.test(text)) return pick('membership');
    if (/core\.users/i.test(text)) return pick('user');
    return [];
  };
  const tx = { startedAt: new Date(), async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); return { rows: answer(text) }; }, savepoint: async (f: any) => f(tx) };
  const repo: any = createCoreRepo({ withTenantScope: async (_t: unknown, _x: string, _a: string, fn: () => unknown) => fn(), systemActorOf } as never);
  const ctx = (over2: Record<string, unknown> = {}) => ({ tenantId: TENANT_A, actor: STAFF, requestId: idN(0xf1), tx, now: () => '2026-11-07T12:00:00.000Z', ports: {}, ...over2 }) as any;
  return { repo, ctx, stmts, tx };
}
const vals = (s: { stmts: Array<{ values: unknown[] }> }) => s.stmts.flatMap((x) => x.values);
const sql = (s: { stmts: Array<{ text: string }> }) => s.stmts.map((x) => x.text).join('\n');

describe('REQ-SEC-024 every read filters by the caller tenant explicitly and binds it', () => {
  const calls: Array<[string, (s: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['tenant', (s) => s.repo.tenant(s.ctx())],
    ['branches', (s) => s.repo.branches(s.ctx())],
    ['branch', (s) => s.repo.branch(s.ctx(), { branchId: BRANCH })],
    ['centres', (s) => s.repo.centres(s.ctx())],
    ['centre', (s) => s.repo.centre(s.ctx(), { centreId: CENTRE })],
    ['user', (s) => s.repo.user(s.ctx(), { userId: USER })],
    ['membership', (s) => s.repo.membership(s.ctx(), { membershipId: MEM })],
    ['membershipPermissions', (s) => s.repo.membershipPermissions(s.ctx(), { membershipId: MEM })],
    ['memberships.list', (s) => s.repo.memberships.list(s.ctx(), {})],
  ];
  for (const [name, call] of calls) {
    it(`${name}: tenant id bound from ctx, tenant_id predicate in every statement, no id concatenated into SQL`, async () => {
      const s = setup();
      await call(s);
      expect(s.stmts.length).toBeGreaterThan(0);
      expect(vals(s)).toContain(TENANT_A);
      for (const st of s.stmts) {
        expect(st.text).toMatch(name === 'tenant' ? /\b(tenant_)?id\s*=\s*\$\d+/i : /\btenant_id\s*=\s*\$\d+/i);
        expect(st.text).not.toContain(TENANT_A);
      }
    });
  }
  it('a caller-supplied tenantId in the input is ignored (tenant comes from ctx only)', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), { tenantId: TENANT_B });
    await s.repo.centres(s.ctx(), { tenantId: TENANT_B });
    expect(vals(s)).not.toContain(TENANT_B);
  });
});

describe('AC-0D-6.5 memberships.list (08 A17 D-47)', () => {
  it('returns { membershipId, displayName, roleCodes, allCentres, isActive } per user-membership', async () => {
    const s = setup();
    const rows = await s.repo.memberships.list(s.ctx(), {});
    expect(rows).toEqual([{ membershipId: MEM, displayName: 'Synthetic Staff', roleCodes: ['lab_tech', 'phlebotomist'], allCentres: false, isActive: true }]);
    expect(Object.keys(rows[0]).sort()).toEqual(['allCentres', 'displayName', 'isActive', 'membershipId', 'roleCodes']);
  });
  it('only actor_type = user memberships are selected', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), {});
    expect(sql(s) + JSON.stringify(vals(s))).toMatch(/actor_type\s*=\s*'user'|"user"/);
    expect(sql(s)).toMatch(/\bactor_type\b/i);
  });
  it('displayName comes from core.users', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), {});
    expect(sql(s)).toMatch(/core\.users/i);
  });

  it('centreId: all_centres or a member of that centre', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), { centreId: CENTRE });
    expect(vals(s)).toContain(CENTRE);
    expect(sql(s)).toMatch(/all_centres/i); expect(sql(s)).toMatch(/core\.membership_centres/i);
  });
  it('roleCode: filters on the role of the membership', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), { roleCode: 'lab_tech' });
    expect(vals(s)).toContain('lab_tech'); expect(sql(s)).toMatch(/core\.roles/i); expect(sql(s)).toMatch(/core\.membership_roles/i);
  });
  it('permission: a role of the membership grants it (core.role_permissions)', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), { permission: 'lab.result.read' });
    expect(vals(s)).toContain('lab.result.read');
    expect(sql(s)).toMatch(/core\.role_permissions/i); expect(sql(s)).toMatch(/permission_code/i);
  });
  it('membershipIds: bound as one array (unknown / other-tenant ids simply do not match)', async () => {
    const s = setup();
    const ids = [MEM, idN(0x3002), idN(0x3003)];
    await s.repo.memberships.list(s.ctx(), { membershipIds: ids });
    expect(vals(s).some((v) => Array.isArray(v) && ids.every((i) => v.includes(i)))).toBe(true);
    expect(sql(s)).toMatch(/ANY\s*\(/i);
  });
  it('membershipIds: 200 accepted, 201 rejected with common.validation_failed and no SQL', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => idN(0x5000 + i));
    const ok = setup();
    await ok.repo.memberships.list(ok.ctx(), { membershipIds: ids(200) });
    expect(ok.stmts.length).toBeGreaterThan(0);
    const bad = setup();
    const e = await rejection(bad.repo.memberships.list(bad.ctx(), { membershipIds: ids(201) }));
    expect(e).toBeInstanceOf(LimsError);
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
    expect(bad.stmts).toHaveLength(0);
  });

  const activeFilter = (s: { stmts: Array<{ text: string; values: unknown[] }> }): 'on' | 'off' => {
    const t = sql(s);
    const w = t.includes('WHERE') || /\bwhere\b/i.test(t) ? t.slice(t.search(/\bWHERE\b/i)) : '';   // the SELECT list also names is_active
    if (!/\bis_active\b|status\s*=\s*'active'/i.test(w)) return 'off';
    const bools = vals(s).filter((v) => typeof v === 'boolean');
    return bools.length ? (bools.includes(true) ? 'on' : 'off') : 'on';
  };
  it('activeOnly defaults to true; activeOnly: false returns inactive memberships too', async () => {
    const a = setup(); await a.repo.memberships.list(a.ctx(), {});
    const b = setup(); await b.repo.memberships.list(b.ctx(), { activeOnly: true });
    const c = setup(); await c.repo.memberships.list(c.ctx(), { activeOnly: false });
    expect(activeFilter(a)).toBe('on'); expect(activeFilter(b)).toBe('on'); expect(activeFilter(c)).toBe('off');
  });
  it('isActive is reported per row', async () => {
    const s = setup({ membership: { is_active: false, status: 'deactivated' } });
    const rows = await s.repo.memberships.list(s.ctx(), { activeOnly: false });
    expect(rows[0].isActive).toBe(false);
  });

  it('limit defaults to 200, accepts 1..500, and 0 / 501 / non-integers are rejected (common.validation_failed)', async () => {
    const d = setup(); await d.repo.memberships.list(d.ctx(), {});
    expect(vals(d)).toContain(200);
    for (const n of [1, 500]) { const s = setup(); await s.repo.memberships.list(s.ctx(), { limit: n }); expect(vals(s)).toContain(n); }
    for (const n of [0, 501, 1.5, -1]) {
      const s = setup();
      const e = await rejection(s.repo.memberships.list(s.ctx(), { limit: n }));
      expect([e.code, s.stmts.length], String(n)).toEqual(['common.validation_failed', 0]);
    }
  });

  it('filters combine (every given filter is bound in the same call)', async () => {
    const s = setup();
    await s.repo.memberships.list(s.ctx(), { centreId: CENTRE, roleCode: 'lab_tech', permission: 'lab.result.read', membershipIds: [MEM], activeOnly: false, limit: 25 });
    const v = vals(s);
    for (const x of [CENTRE, 'lab_tech', 'lab.result.read', 25, TENANT_A]) expect(v).toContain(x);
    expect(v.some((y) => Array.isArray(y) && y.includes(MEM))).toBe(true);
  });

  for (const type of ['partner', 'portal', 'patient']) {
    it(`a ${type} caller gets auth.forbidden (403) and no SQL runs`, async () => {
      const s = setup();
      const e = await rejection(s.repo.memberships.list(s.ctx({ actor: { type, id: USER } }), {}));
      expect(e).toBeInstanceOf(LimsError);
      expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
      expect(s.stmts).toHaveLength(0);
    });
  }
  for (const type of ['user', 'system']) {
    it(`a ${type} caller is allowed`, async () => {
      const s = setup();
      await expect(s.repo.memberships.list(s.ctx({ actor: { type, id: USER } }), {})).resolves.toHaveLength(1);
    });
  }
});

describe('membership() / MembershipRow (08 A17 D-47)', () => {
  it('maps the full MembershipRow', async () => {
    const s = setup({ membership: { locked_at: new Date(Date.UTC(2026, 10, 6, 8, 30)) } });
    const m = await s.repo.membership(s.ctx(), { membershipId: MEM });
    expect(m).toEqual({
      membershipId: MEM, userId: USER, actorType: 'user', displayName: 'Synthetic Staff', status: 'active', isActive: true,
      lockedAt: '2026-11-06T08:30:00.000Z', allCentres: false, centreIds: [CENTRE, CENTRE2], roleCodes: ['lab_tech', 'phlebotomist'],
    });
  });
  it('lockedAt is omitted when the membership is not locked', async () => {
    const s = setup();
    const m = await s.repo.membership(s.ctx(), { membershipId: MEM });
    expect(m.lockedAt).toBeUndefined();
  });
  it('unknown or other-tenant id throws common.not_found', async () => {
    const s = setup({ membership: null });
    const e = await rejection(s.repo.membership(s.ctx(), { membershipId: idN(0x9999) }));
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
  });
  it('membershipPermissions returns permission codes of the membership roles', async () => {
    const s = setup();
    await expect(s.repo.membershipPermissions(s.ctx(), { membershipId: MEM })).resolves.toEqual(['lab.result.read', 'lab.result.enter']);
  });
});

describe('centres / CentreRow (phoneDisplay, C4 hand-off) and branches', () => {
  it('centres(): CentreRow carries phoneDisplay and the schema columns, camelCased', async () => {
    const s = setup();
    const [c] = await s.repo.centres(s.ctx());
    expect(c).toEqual({ id: CENTRE, branchId: BRANCH, centreCode: 'C-01', name: 'Baneshwor Centre', centreKind: 'own', addressText: 'Synthetic Chowk 2', phoneDisplay: '01-4411111', isActive: true });
  });
  it('centre(): same row; NULL phone_display / address_text are omitted, not null', async () => {
    const s = setup({ centre: { phone_display: null, address_text: null } });
    const c = await s.repo.centre(s.ctx(), { centreId: CENTRE });
    expect(c.phoneDisplay).toBeUndefined(); expect(c.addressText).toBeUndefined();
    expect(c).toMatchObject({ id: CENTRE, centreKind: 'own', isActive: true });
  });
  it('centres(): phone_display is selected from core.collection_centres', async () => {
    const s = setup();
    await s.repo.centres(s.ctx());
    expect(sql(s)).toMatch(/phone_display/i); expect(sql(s)).toMatch(/core\.collection_centres/i);
  });
  it('centres({ kinds }) filters by centre_kind (bound array); branchId and activeOnly are bound too', async () => {
    const s = setup();
    await s.repo.centres(s.ctx(), { kinds: ['own', 'home_collection'], branchId: BRANCH, activeOnly: true });
    expect(vals(s).some((v) => Array.isArray(v) && v.includes('own') && v.includes('home_collection'))).toBe(true);
    expect(vals(s)).toContain(BRANCH);
    expect(sql(s)).toMatch(/centre_kind/i);
  });
  it('centres() without kinds does not filter by kind', async () => {
    const s = setup();
    await s.repo.centres(s.ctx());
    expect(sql(s)).not.toMatch(/centre_kind\s*(=|IN|<>)|centre_kind\s*=\s*ANY/i);
  });
  it('centre(): unknown id throws common.not_found', async () => {
    const s = setup({ centre: null });
    const e = await rejection(s.repo.centre(s.ctx(), { centreId: idN(0x9999) }));
    expect(e.code).toBe('common.not_found');
  });
  it('branches() / branch(): BranchRow with phoneDisplay; unknown id not_found', async () => {
    const s = setup();
    const [b] = await s.repo.branches(s.ctx());
    expect(b).toEqual({ id: BRANCH, branchCode: 'KTM', name: 'Kathmandu Main', addressText: 'Synthetic Road 1', phoneDisplay: '01-4400000', isProcessingLab: true, isActive: true });
    const none = setup({ branch: null });
    expect((await rejection(none.repo.branch(none.ctx(), { branchId: BRANCH }))).code).toBe('common.not_found');
  });
  it('tenant(): maps the tenant row', async () => {
    const s = setup();
    await expect(s.repo.tenant(s.ctx())).resolves.toEqual({ id: TENANT_A, tenantCode: 'demo-lab', displayName: 'Demo Lab', legalName: 'Demo Laboratories Pvt Ltd', status: 'active', timezone: 'Asia/Kathmandu' });
  });
  it('user(): maps { id, displayName, isActive }; unknown id not_found', async () => {
    const s = setup();
    await expect(s.repo.user(s.ctx(), { userId: USER })).resolves.toEqual({ id: USER, displayName: 'Synthetic Staff', isActive: true });
    const none = setup({ user: null });
    expect((await rejection(none.repo.user(none.ctx(), { userId: USER }))).code).toBe('common.not_found');
  });
});
