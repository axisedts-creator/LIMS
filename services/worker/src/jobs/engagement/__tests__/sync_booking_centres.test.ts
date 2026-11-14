// C16.T-B2 — task `engagement.sync_booking_centres` (booking_centres projection) and its nightly cron `engagement.sync_booking_centres_nightly`.
// (06-PLAN row T-B2; 02-TRD §8.1 (task row), §8.2 (daily 01:50 Asia/Kathmandu, per_tenant); 05-SCHEMA booking_centres (E, system-written only); 08 A19 D-119; 08 A13 P-6; REQ-SEC-024 tenant guard.)
// done_when: template save enqueues the centre sync (API side: slot.handlers.test.ts). tests: integration; timezone fixture (Asia/Kathmandu UTC+05:45).
// Fails now: manifest.tasks['engagement.sync_booking_centres'] is the T-01 fail-closed stub (throws "not implemented"); no `_nightly` task or cron row exists.
//
// SEAMS (spec fixes behaviour, not names; same convention as close_queue_day.test.ts / reminders.test.ts):
//   manifest.tasks[...](payload, ctx): payload {tenant_id}; ctx = worker JobContext (tenantId, tx, actor = system actor, now(): ISO string, core, log, metrics).
//   Centres come from `ctx.core.centres(ctx, {...})` (the real core-repo method, services/api/src/core/core-repo) — the fake ALSO exposes `.list` on it (03-IC writes `ctx.core.centres.list`) and `ctx.core.centre(ctx, {centreId})`.
//     Rows are C0 CentreRow: {id, branchId, centreCode, name, centreKind, addressText?, phoneDisplay?, isActive}. The fake honours `activeOnly` and `kinds` if the task passes them; the spec wants ALL centres of the tenant
//     (any kind, active or not), so a task that filters them away fails the tests below.
//   DB through ctx.tx.query = FakeDb (api __tests__/fakeSql.ts; subset: plain SELECT / INSERT .. ON CONFLICT (..) DO UPDATE SET c = EXCLUDED.c / UPDATE .. WHERE .. `col = ANY($n)`; no OR / JOIN / sub-select / NOT IN).
//   Upsert key (tenant_id, centre_id); the row id and created_* never change on a re-sync; synced_at = ctx.now(); updated_by = ctx.actor.id; display_name = core name; address_text = addressText or NULL.
//   Centres absent from core's list, or inactive there -> is_active = false (rows are never deleted; no DELETE statement). Core failing -> the task THROWS (retry) and deactivates nothing.
//   Over-long core data (name > 200, address > 300: the schema CHECKs) must not wedge the whole sync: the task shortens or skips that centre and syncs the others.
//   Nightly cron: 01:50 NPT (UTC+05:45) = 20:05 UTC -> schedule fields are UTC (core/manifest.ts) -> `5 20 * * *`, per_tenant. Its task only ENQUEUES: `SELECT app.enqueue_job($1, $2::jsonb, $3, ..)` with
//   $1 'engagement.sync_booking_centres', $2 JSON {tenant_id}, $3 'bcentres:<tenant_id>' (numeric max-attempts argument = 5); it never calls core and never writes booking_centres.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { FakeDb, type Call, type Row } from '../../../../../api/src/modules/engagement/__tests__/fakeSql.js';

const SYNC = 'engagement.sync_booking_centres', NIGHTLY = 'engagement.sync_booking_centres_nightly';
const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const C1 = ID(0xc01), C2 = ID(0xc02), C3 = ID(0xc03), C4 = ID(0xc04), C5 = ID(0xc05), C6 = ID(0xc06), CB = ID(0xcb1);
const BR1 = ID(0xb01), BR2 = ID(0xb02), BRB = ID(0xbb1);
const BC1 = ID(0xd01), BC5 = ID(0xd05), BCB = ID(0xdb1);
const SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = '2026-11-13T20:05:00.000Z'; // 01:50 NPT on 2026-11-14 = the nightly fire time
const OLD = '2026-11-01T00:00:00.000Z';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;

const centre = (id: string, o: Row = {}): Row => ({ id, branchId: BR1, centreCode: `C-${id.slice(-3)}`, name: 'Centre', centreKind: 'own', addressText: undefined, phoneDisplay: '+977-1-5550100', isActive: true, ...o });
const coreRows = (): Row[] => [
  centre(C1, { name: 'Main Lab', addressText: 'Synthetic Road 1, Kathmandu' }), centre(C2, { name: 'Patan Collection Point', centreKind: 'franchise' }),
  centre(C3, { name: 'Home Collection', centreKind: 'home_collection', branchId: BR2, addressText: 'Synthetic Hub 7' }), centre(C4, { name: 'Closed Centre', isActive: false }),
];
const bc = (id: string, tenant: string, centreId: string, o: Row = {}): Row => ({
  id, tenant_id: tenant, centre_id: centreId, branch_id: tenant === TA ? BR1 : BRB, display_name: 'Old Name', address_text: 'Old address', is_active: true, synced_at: OLD,
  created_at: OLD, created_by: 'creator-1', updated_at: OLD, updated_by: 'creator-1', ...o });

function setup(o: { core?: Row[]; tenantId?: string | null; failCore?: boolean; existing?: Row[] } = {}) {
  const clock = { iso: NOW };
  const centreIds = [C1, C2, C3, C4, C5, C6];
  const db = new FakeDb({
    collection_centres: [...centreIds.map((id) => ({ id, tenant_id: TA })), { id: CB, tenant_id: TB }],
    branches: [{ id: BR1, tenant_id: TA }, { id: BR2, tenant_id: TA }, { id: BRB, tenant_id: TB }],
    booking_centres: o.existing ?? [bc(BC1, TA, C1), bc(BC5, TA, C5), bc(BCB, TB, CB, { display_name: 'Tenant B centre' })],
  }, {
    collection_centres: { columns: ['id', 'tenant_id'] }, branches: { columns: ['id', 'tenant_id'] },
    booking_centres: {
      columns: ['id', 'tenant_id', 'centre_id', 'branch_id', 'display_name', 'address_text', 'is_active', 'synced_at', 'created_at', 'created_by', 'updated_at', 'updated_by'],
      notNull: ['id', 'tenant_id', 'centre_id', 'branch_id', 'display_name', 'is_active', 'synced_at', 'created_by', 'updated_by'], defaults: { is_active: true, created_at: clock.iso, updated_at: clock.iso },
      unique: [['tenant_id', 'id'], ['tenant_id', 'centre_id']],
      fk: [{ cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'branch_id'], ref: 'branches', refCols: ['tenant_id', 'id'] }],
      check: (r) => (String(r['display_name']).length < 1 || String(r['display_name']).length > 200 || (r['address_text'] != null && String(r['address_text']).length > 300) ? 'booking_centres__lengths__ck' : undefined),
    },
  }, clock);
  const s = db.session(TA, { all: true, centres: [] }, SYSTEM);
  const state = { rows: o.core ?? coreRows(), fail: Boolean(o.failCore) };
  const coreCalls: unknown[][] = [];
  const centres = async (...args: unknown[]) => {
    coreCalls.push(args); if (state.fail) throw new Error('core unavailable');
    const i = (args[1] ?? {}) as { activeOnly?: boolean; kinds?: string[] };
    return state.rows.filter((r) => (i.activeOnly ? r['isActive'] : true) && (i.kinds ? i.kinds.includes(r['centreKind']) : true));
  };
  const ctx: any = {
    tenantId: o.tenantId === null ? undefined : (o.tenantId ?? TA), tx: s.tx, actor: { type: 'system', id: SYSTEM }, requestId: 'r', attempt: 1, maxAttempts: 5, jobId: '1',
    now: () => clock.iso, isNewer: () => true, events: {}, storage: {}, files: {}, audit: {},
    core: { centres: Object.assign(centres, { list: centres }), centre: async (_c: unknown, i: { centreId: string }) => { const r = state.rows.find((x) => x['id'] === i.centreId); if (!r) throw new Error('not_found'); return r; } },
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { db, ctx, clock, coreCalls, state, rows: () => db.tables['booking_centres'] as Row[] };
}
const run = async (id: string, payload: Record<string, unknown>, s: ReturnType<typeof setup>) => (await manifest()).tasks[id](payload, s.ctx);
const mine = (s: ReturnType<typeof setup>) => s.rows().filter((r) => r['tenant_id'] === TA);
const byCentre = (s: ReturnType<typeof setup>, c: string) => mine(s).find((r) => r['centre_id'] === c);
const iso = (v: unknown) => new Date(v as string).toISOString();
const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const enq = (db: FakeDb) => db.calls.filter((c) => /app\.enqueue_job/i.test(c.text));

describe('manifest + crontab (02-TRD §8.1, §8.2)', () => {
  it('engagement.sync_booking_centres keeps maxAttempts 5 and is no longer the fail-closed stub (a bad payload resolves quietly instead of throwing "not implemented")', async () => {
    const m = await manifest();
    expect(m.maxAttempts?.[SYNC]).toBe(5);
    expect(() => validateManifests([m])).not.toThrow();
    await expect(m.tasks[SYNC]({}, setup().ctx)).resolves.toBeUndefined();
  });
  it('one cron row engagement.sync_booking_centres_nightly: 01:50 Asia/Kathmandu = `5 20 * * *` (UTC fields), per_tenant; registered as a task; cron.ts exports the frozen crontab the manifest uses', async () => {
    const m = await manifest();
    const rows = ((m.crontab ?? []) as any[]).filter((x) => x.identifier === NIGHTLY);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ schedule: '5 20 * * *', tenantScope: 'per_tenant' });
    expect(typeof m.tasks?.[NIGHTLY]).toBe('function');
    const cron: any = await import('../cron.js'); expect(cron.crontab).toBe(m.crontab); expect(Object.isFrozen(cron.crontab)).toBe(true);
  });
  it('existing cron rows are untouched (close_queue_day, dispatch_due_reminders, purge tasks)', async () => {
    const ids = ((await manifest()).crontab as any[]).map((x) => x.identifier);
    for (const id of ['engagement.close_queue_day', 'engagement.dispatch_due_reminders', 'engagement.purge_ephemeral', 'engagement.purge_queue']) expect(ids, id).toContain(id);
  });
});

describe('nightly task: only enqueues the sync for its own tenant (job key bcentres:<tenant_id>)', () => {
  it('enqueues exactly once with the tenant payload and the per-tenant job key; no core call, no booking_centres access', async () => {
    const s = setup(); await run(NIGHTLY, { tenant_id: TA }, s);
    const e = enq(s.db); expect(e).toHaveLength(1);
    expect(e[0]!.values[0]).toBe(SYNC); expect(JSON.parse(String(e[0]!.values[1]))).toEqual({ tenant_id: TA }); expect(e[0]!.values[2]).toBe(`bcentres:${TA}`);
    for (const v of e[0]!.values.slice(3)) if (typeof v === 'number') expect(v).toBe(5);
    expect(s.coreCalls).toEqual([]); expect(s.db.calls.filter((c) => /booking_centres/i.test(c.text))).toEqual([]);
  });
  for (const [name, payload, tenantId] of [
    ['payload without tenant_id', {}, TA], ['payload tenant_id of another tenant', { tenant_id: TB }, TA], ['payload tenant_id but ctx without tenant', { tenant_id: TA }, null], ['payload tenant_id that is not a uuid', { tenant_id: "x' OR '1'='1" }, TA],
  ] as const) {
    it(`tenant guard — ${name}: nothing is enqueued, the task resolves`, async () => {
      const s = setup({ tenantId }); await expect(run(NIGHTLY, payload as Record<string, unknown>, s)).resolves.toBeUndefined(); expect(s.db.calls).toHaveLength(0);
    });
  }
});

describe('sync_booking_centres: upsert the booking_centres projection from core (08 A19 D-119)', () => {
  it('inserts every centre of the tenant (own, franchise, home_collection; active or not) and refreshes the existing one; ids, created_* stay; synced_at = now; updated_by = system actor', async () => {
    const s = setup(); await run(SYNC, { tenant_id: TA }, s);
    expect(mine(s).filter((r) => [C1, C2, C3, C4].includes(r['centre_id'])).length).toBe(4); // exactly one row per centre
    const c1 = byCentre(s, C1)!;
    expect(c1).toMatchObject({ id: BC1, tenant_id: TA, branch_id: BR1, display_name: 'Main Lab', address_text: 'Synthetic Road 1, Kathmandu', is_active: true, created_by: 'creator-1', updated_by: SYSTEM });
    expect(iso(c1['created_at'])).toBe(OLD); expect(iso(c1['synced_at'])).toBe(NOW);
    expect(byCentre(s, C2)).toMatchObject({ tenant_id: TA, branch_id: BR1, display_name: 'Patan Collection Point', is_active: true, created_by: SYSTEM, updated_by: SYSTEM }); expect(byCentre(s, C2)!['address_text'] ?? null).toBeNull();
    expect(byCentre(s, C3)).toMatchObject({ branch_id: BR2, display_name: 'Home Collection', address_text: 'Synthetic Hub 7', is_active: true });
    for (const r of mine(s)) if ([C2, C3, C4].includes(r['centre_id'])) { expect(r['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i); expect(iso(r['synced_at'])).toBe(NOW); }
  });
  it('a centre inactive in core gets a row with is_active = false; a centre missing from core (C5, previously active) is deactivated and kept; reactivation in core flips it back on the next run', async () => {
    const s = setup(); await run(SYNC, { tenant_id: TA }, s);
    expect(byCentre(s, C4)!['is_active']).toBe(false);
    expect(byCentre(s, C5)).toMatchObject({ id: BC5, is_active: false, display_name: 'Old Name' }); // kept as it was, only deactivated
    s.state.rows = s.state.rows.map((r) => (r['id'] === C4 ? { ...r, isActive: true } : r)); s.clock.iso = '2026-11-14T20:05:00.000Z';
    await run(SYNC, { tenant_id: TA }, s);
    expect(byCentre(s, C4)!['is_active']).toBe(true); expect(iso(byCentre(s, C4)!['synced_at'])).toBe('2026-11-14T20:05:00.000Z');
  });
  it('a name/address change in core reaches the projection; a second run is idempotent (same rows and ids, no duplicates, no deletes)', async () => {
    const s = setup(); await run(SYNC, { tenant_id: TA }, s);
    const ids = new Map(mine(s).map((r) => [r['centre_id'], r['id']]));
    s.state.rows = s.state.rows.map((r) => (r['id'] === C2 ? { ...r, name: 'Patan Point (renamed)', addressText: 'New Address 5' } : r)); s.clock.iso = '2026-11-14T20:05:00.000Z';
    await run(SYNC, { tenant_id: TA }, s); await run(SYNC, { tenant_id: TA }, s);
    expect(byCentre(s, C2)).toMatchObject({ display_name: 'Patan Point (renamed)', address_text: 'New Address 5' });
    expect(mine(s).length).toBe(ids.size); for (const r of mine(s)) expect(r['id']).toBe(ids.get(r['centre_id']));
    expect(s.db.calls.some((c) => verb(c) === 'delete')).toBe(false);
  });
  it('tenant isolation: tenant B\'s row is byte-identical; every statement on booking_centres binds the tenant id; the task acts as the system actor', async () => {
    const s = setup(); const b = JSON.stringify(s.rows().find((r) => r['tenant_id'] === TB)); await run(SYNC, { tenant_id: TA }, s);
    expect(JSON.stringify(s.rows().find((r) => r['tenant_id'] === TB))).toBe(b);
    const stmts = s.db.calls.filter((c) => /engagement\.booking_centres/i.test(c.text)); expect(stmts.length).toBeGreaterThan(0);
    for (const c of stmts) { expect(c.text).toMatch(/tenant_id/); expect(c.values).toContain(TA); }
    expect(mine(s).every((r) => r['tenant_id'] === TA)).toBe(true);
  });
  it('asks core with the job context (system actor, tenant from ctx) and does not narrow the list to active or to some kinds', async () => {
    const s = setup(); await run(SYNC, { tenant_id: TA }, s);
    expect(s.coreCalls.length).toBeGreaterThan(0);
    const call = s.coreCalls[0]!; expect(call[0]).toBe(s.ctx);
    const input = (call[1] ?? {}) as { activeOnly?: boolean; kinds?: string[] }; expect(input.activeOnly).not.toBe(true); expect(input.kinds ?? null).toBeNull();
  });
  it('core data that violates the projection CHECKs (name 250 chars, address 400 chars) does not wedge the sync: others are synced, anything stored fits the limits', async () => {
    const s = setup({ core: [...coreRows(), centre(C6, { name: 'N'.repeat(250), addressText: 'a'.repeat(400) })] });
    await expect(run(SYNC, { tenant_id: TA }, s)).resolves.toBeUndefined();
    expect(byCentre(s, C2)).toMatchObject({ display_name: 'Patan Collection Point', is_active: true });
    const long = byCentre(s, C6); if (long) { expect(String(long['display_name']).length).toBeLessThanOrEqual(200); expect(String(long['address_text'] ?? '').length).toBeLessThanOrEqual(300); }
  });
  it('core unavailable: the task throws (so the job retries) and changes nothing — no centre is deactivated because the list could not be read', async () => {
    const s = setup({ failCore: true }); const before = JSON.stringify(s.rows());
    await expect(run(SYNC, { tenant_id: TA }, s)).rejects.toThrow(/core unavailable/); expect(s.coreCalls.length).toBeGreaterThan(0); expect(JSON.stringify(s.rows())).toBe(before);
    expect(s.db.calls.filter((c) => ['insert', 'update', 'delete'].includes(verb(c) ?? ''))).toEqual([]);
  });
  it('no PII or secrets in the projection: only the contract columns are written (no phone_display, centre_code, patient data)', async () => {
    const s = setup(); await run(SYNC, { tenant_id: TA }, s);
    for (const r of mine(s)) expect(Object.keys(r).sort()).toEqual(['address_text', 'branch_id', 'centre_id', 'created_at', 'created_by', 'display_name', 'id', 'is_active', 'synced_at', 'tenant_id', 'updated_at', 'updated_by']);
    expect(JSON.stringify(mine(s))).not.toContain('5550100');
  });
});

describe('tenant guard (REQ-SEC-024): the job acts only on the tenant it was enqueued for', () => {
  for (const [name, payload, tenantId] of [
    ['payload without tenant_id', {}, TA], ['payload tenant_id of another tenant', { tenant_id: TB }, TA], ['payload tenant_id but ctx without tenant', { tenant_id: TA }, null], ['payload tenant_id that is not a uuid', { tenant_id: "x' OR '1'='1" }, TA],
  ] as const) {
    it(`${name}: no statement runs, core is not called, the task resolves`, async () => {
      const s = setup({ tenantId }); const before = JSON.stringify(s.rows());
      await expect(run(SYNC, payload as Record<string, unknown>, s)).resolves.toBeUndefined();
      expect(s.db.calls).toHaveLength(0); expect(s.coreCalls).toEqual([]); expect(JSON.stringify(s.rows())).toBe(before);
    });
  }
});
