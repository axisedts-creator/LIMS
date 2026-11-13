// Self-check of the T10 test world (conversion.world.ts): savepoint restore, whole-job rollback, centre scope injection, order_tracking constraints, marker port.
// A bug here would make the T10 tests lie, so the machinery is proven on its own with hand-written SQL (no implementation code involved).
import { describe, expect, it } from 'vitest';
import { CE, id, L, M, makeJobCtx, makeStaffCtx, makeWorld10, markerPort, makeFrontdesk, OR, P, release, runJob, SYS, T_A, wrapTx, type Row } from './conversion.world.js';

const TRACK = ['tenant_id', 'order_id', 'partner_id', 'line_id', 'manifest_id', 'receiving_centre_id', 'registration_no', 'tracking_status', 'registered_at', 'last_event_at', 'created_by', 'updated_by'];
const TRACK_SQL = `INSERT INTO partners.order_tracking (${TRACK.join(', ')}) VALUES ($1, $2, $3, $4, $5, $6, $7, 'registered', now(), now(), $8, $8)`;
const trackVals = (over: Partial<Record<string, unknown>> = {}) => {
  const base: Record<string, unknown> = { tenant_id: T_A, order_id: id(7001), partner_id: P.x, line_id: L.xs, manifest_id: M.xs, receiving_centre_id: CE.a1, registration_no: '0001SY000009', actor: SYS, ...over };
  return [base['tenant_id'], base['order_id'], base['partner_id'], base['line_id'], base['manifest_id'], base['receiving_centre_id'], base['registration_no'], base['actor']];
};

describe('T10 world self-check', () => {
  it('ctx.db.tx is a real savepoint: a throwing callback undoes its own writes (marker + line update) and nothing before it', async () => {
    const w = makeWorld10(); const { ctx } = makeJobCtx(w);
    await ctx.tx.query("UPDATE partners.manifest_lines SET failure_code = NULL, version = version + 1 WHERE tenant_id = $1 AND id = $2", [T_A, L.xs]); // before the savepoint
    const v = w.lines.find((l) => l['id'] === L.xs)!['version'];
    await expect(ctx.db.tx(async (c: any) => {
      await c.tx.query('INSERT INTO fake_c4.markers (id) VALUES ($1)', ['m1']);
      await c.tx.query("UPDATE partners.manifest_lines SET version = version + 1 WHERE tenant_id = $1 AND id = $2", [T_A, L.xs]);
      expect(w.markers).toHaveLength(1);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(w.markers).toEqual([]); expect(w.lines.find((l) => l['id'] === L.xs)!['version']).toBe(v);
    release(ctx);
  });

  it('a callback that returns keeps its writes (savepoint released)', async () => {
    const w = makeWorld10(); const { ctx, sp } = makeJobCtx(w);
    await ctx.db.tx(async (c: any) => { await c.tx.query('INSERT INTO fake_c4.markers (id) VALUES ($1)', ['m1']); });
    expect(w.markers).toHaveLength(1); expect(sp.opened).toBe(1); expect(sp.n).toBe(0);
  });

  it('runJob: a throwing job commits nothing (whole-transaction rollback); a returning job commits', async () => {
    const w = makeWorld10();
    const bad = await runJob(w, async (_p, c) => { await c.tx.query('INSERT INTO fake_c4.markers (id) VALUES ($1)', ['m']); await c.tx.query(TRACK_SQL, trackVals()); throw new Error('infra'); }, {});
    expect(bad.threw).toBeInstanceOf(Error); expect(w.markers).toEqual([]); expect(w.tracking).toEqual([]);
    const ok = await runJob(w, async (_p, c) => { await c.tx.query(TRACK_SQL, trackVals()); }, {});
    expect(ok.threw).toBeUndefined(); expect(w.tracking).toHaveLength(1);
  });

  it('staff scope: statements on manifests / manifest_lines only see the staff centres (SELECT, FOR UPDATE, UPDATE); all-centres sees everything', async () => {
    const w = makeWorld10();
    const sel = async (centres: string[] | 'all') => { const tx = wrapTx(w, centres); try { return (await tx.query('SELECT id FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, M.xs])).rows; } finally { release({ tx }); } };
    expect(await sel([CE.a1])).toHaveLength(1); expect(await sel([CE.a2])).toHaveLength(0); expect(await sel('all')).toHaveLength(1);
    const c2 = wrapTx(w, [CE.a2]);
    const up = await c2.query("UPDATE partners.manifests SET state = 'received' WHERE tenant_id = $1 AND id = $2", [T_A, M.xs]); release({ tx: c2 });
    expect(up.rowCount).toBe(0); expect(w.manifests.find((m) => m['id'] === M.xs)!['state']).toBe('submitted');
    const lines = wrapTx(w, [CE.a2]); expect((await lines.query('SELECT id FROM partners.manifest_lines WHERE tenant_id = $1 ORDER BY line_no LIMIT 50', [T_A])).rows.every((r: Row) => w.lines.find((l) => l['id'] === r['id'])!['receiving_centre_id'] === CE.a2)).toBe(true);
    const bare = wrapTx(w, [CE.a1]); expect((await bare.query('SELECT id FROM partners.manifests')).rows.every((r: Row) => w.manifests.find((m) => m['id'] === r['id'])!['receiving_centre_id'] === CE.a1)).toBe(true);
  });

  it('order_tracking: NOT NULL receiving_centre_id, status CHECK, unique order / line, FKs, ON CONFLICT DO NOTHING', async () => {
    const w = makeWorld10(); const tx = wrapTx(w, 'all');
    await expect(tx.query(TRACK_SQL, trackVals({ receiving_centre_id: null }))).rejects.toMatchObject({ code: '23502' });
    await expect(tx.query(TRACK_SQL.replace("'registered'", "'bogus'"), trackVals())).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query(TRACK_SQL, trackVals({ line_id: id(1) }))).rejects.toMatchObject({ code: '23503' });
    await tx.query(TRACK_SQL, trackVals());
    await expect(tx.query(TRACK_SQL, trackVals())).rejects.toMatchObject({ code: '23505' });
    expect((await tx.query(`${TRACK_SQL} ON CONFLICT DO NOTHING`, trackVals())).rowCount).toBe(0);
    const sel = await tx.query('SELECT order_id, tracking_status FROM partners.order_tracking WHERE tenant_id = $1 AND line_id = $2', [T_A, L.xs]);
    expect(sel.rows).toEqual([{ ...sel.rows[0], order_id: id(7001), tracking_status: 'registered' }]);
    const staff2 = wrapTx(w, [CE.a2]); expect((await staff2.query('SELECT order_id FROM partners.order_tracking WHERE tenant_id = $1', [T_A])).rows).toEqual([]);
    release({ tx });
  });

  it('marker port: marker is written before the fake answers, failNext throws AFTER the marker, depth is recorded', async () => {
    const w = makeWorld10(); const fd = makeFrontdesk(); const depths: number[] = [];
    const { ctx } = makeJobCtx(w, { port: markerPort(fd, depths) });
    fd.failNext('createOrderFromBooking', 'frontdesk.patient_duplicate_suspected');
    await expect(ctx.db.tx((c: any) => c.ports.FrontdeskPort.createOrderFromBooking(c, { source: 'partner_manifest', sourceRefId: L.xs }))).rejects.toMatchObject({ code: 'frontdesk.patient_duplicate_suspected' });
    expect(w.markers).toEqual([]); expect(depths).toEqual([1]);
    const ok = await ctx.db.tx((c: any) => c.ports.FrontdeskPort.createOrderFromBooking(c, { source: 'partner_manifest', sourceRefId: L.xs, partnerId: P.x, orderableIds: [OR.glu], patient: { patientId: id(81) },
      branchId: id(10), centreId: CE.a1, priority: 'routine', confirmImmediately: true, idempotencyKey: `partners:${L.xs}:v1` }));
    expect(ok.replayed).toBe(false); expect(w.markers).toHaveLength(1); expect(fd.calls('createOrderFromBooking')).toHaveLength(2);
  });

  it('staff ctx: assertRole records the requirement and refuses a centre outside the scope / a missing permission', async () => {
    const w = makeWorld10(); const s = makeStaffCtx(w, { centres: [CE.a1] });
    await s.ctx.ports.IdentityPort.assertRole(s.ctx, { permission: 'partners.manifest.receive', centreId: CE.a1 });
    await expect(s.ctx.ports.IdentityPort.assertRole(s.ctx, { permission: 'partners.manifest.receive', centreId: CE.a2 })).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(s.ctx.ports.IdentityPort.assertRole(s.ctx, { permission: 'partners.partner.manage' })).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(s.roleCalls).toHaveLength(3); expect(s.ctx.actor).toMatchObject({ type: 'user' });
  });
});
