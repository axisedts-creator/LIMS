// HC-T11 A4 ackSync (POST /v1/homecollection/sync/ack, `homecollection.sync.upload`, body {device_id, cursor <= 512, applied_at_device, max_device_seq_acked >= 0, wipe_completed?}, `204`).
// 02-TRD §6.4 (updates devices.last_ack_at, last_ack_cursor, routes.last_ack_at for the routes in the cursor; `wipe_completed: true` -> device `wiped`, `wiped_at`), §5.2 device-id binding (A2-A5: membership = actor and
// status in {active, wipe_requested}, else 409 homecollection.device_not_registered), 01-PRD US-13-5 (wipe flow) + US-06-6/7, 07-SECURITY AB1 / §5. Fails now: A4 is an HC-T01 stub (501).
import { describe, expect, it } from 'vitest';
import { MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, T, TENANT_A, TENANT_B, ack, ackBody, ackFails, as, deviceRow, hdr, mkRoute, pullFails, pullS, routeRow, scenario, seedDevice, allAccessRows, superTx, v7 } from './helpers.js';

const FILE = 1;
const mkCursor = (date: string, routes: Array<[string, number]>, o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ v: 1, d: date, r: routes, s: 1, w: 'active', ...o })).toString('base64url');
const frozen = (r: any) => ({ status: r.status, membership_id: r.membership_id, max_device_seq_received: r.max_device_seq_received, last_snapshot_at: r.last_snapshot_at, last_ack_at: r.last_ack_at, last_ack_cursor: r.last_ack_cursor,
  wiped_at: r.wiped_at, signed_off_at: r.signed_off_at, version: r.version });
const wipeRequested = (id: string) => superTx(async (tx) => {
  await tx.query(`UPDATE homecollection.devices SET status = 'wipe_requested', wipe_requested_at = now(), wipe_requested_by = $2, wipe_reason_code = 'lost', version = version + 1 WHERE id = $1`, [id, MEMBER2.a]);
}, TENANT_A);

describe('A4 ack: the device durably replaced its cache with snapshot `cursor` (02-TRD §6.4)', () => {
  it('pull -> ack with the cursor it got: 204 no body; devices.last_ack_at = server time, last_ack_cursor = the cursor, routes.last_ack_at set for the route in the cursor; nothing else on the device changes', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const before = frozen(await deviceRow(S.device.id));
    const ackNow = new Date(S.now.getTime() + 5 * 60_000);
    const r = await ack(ackBody(S.device.id, p.body.cursor, { max_device_seq_acked: 3 }), { now: ackNow });
    expect(r.status).toBe(204);
    expect(r.body ?? null).toBeNull();
    const row = await deviceRow(S.device.id);
    expect(new Date(row.last_ack_at).getTime()).toBe(ackNow.getTime());   // server clock, not applied_at_device (ASSUMED: the device clock is not trusted)
    expect(row.last_ack_cursor).toBe(p.body.cursor);
    expect(frozen(row)).toEqual({ ...before, last_ack_at: row.last_ack_at, last_ack_cursor: p.body.cursor, version: expect.any(Number) });
    expect(new Date((await routeRow(S.route.id)).last_ack_at).getTime()).toBe(ackNow.getTime());
    expect((await routeRow(S.routeTomorrow.id)).last_ack_at).toBeNull();
    expect((await routeRow(S.otherRoute.id)).last_ack_at).toBeNull();
    expect(r.probe.identity.map((c) => c.permission)).toContain(P.sync);
  });
  it('an ack makes no port call and writes no access-log row (no patient data is touched)', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const r = await ack(ackBody(S.device.id, p.body.cursor), { now: S.now });
    expect([r.probe.batch.length, r.probe.lab.length, r.probe.balance.length]).toEqual([0, 0, 0]);
    expect(await allAccessRows(r.probe.requestId)).toHaveLength(0);
  });
  it('replay of the same ack -> 204 again (idempotent) and the stored cursor is unchanged', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const b = ackBody(S.device.id, p.body.cursor);
    expect((await ack(b, { now: S.now })).status).toBe(204);
    expect((await ack(b, { now: S.now })).status).toBe(204);
    expect((await deviceRow(S.device.id)).last_ack_cursor).toBe(p.body.cursor);
  });
  it('the cursor is client data: route ids in it that are not the actor\'s (PHLEBO2\'s route, a tenant B route) are never touched; an unparseable cursor is stored but touches no route [ASSUMED: 204, opaque]', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const bRoute = await mkRoute('b', MEMBER.b, S.date);
    const forged = mkCursor(S.date, [[S.otherRoute.id, 1], [bRoute.id, 1], [S.route.id, 1]]);
    expect((await ack(ackBody(S.device.id, forged), { now: S.now })).status).toBe(204);
    expect((await routeRow(S.otherRoute.id)).last_ack_at).toBeNull();
    expect((await routeRow(bRoute.id)).last_ack_at).toBeNull();
    expect((await routeRow(S.route.id)).last_ack_at).not.toBeNull();
    const d2 = await seedDevice('a');
    expect((await ack(ackBody(d2.id, 'bm90LWpzb24'), { now: S.now })).status).toBe(204);
    expect((await routeRow(S.routeTomorrow.id)).last_ack_at).toBeNull();
  });
  it('a cursor naming a route id that does not exist is ignored (no 500, no phantom row)', { timeout: T }, async () => {
    const S = await scenario(FILE);
    expect((await ack(ackBody(S.device.id, mkCursor(S.date, [[v7(), 1]])), { now: S.now })).status).toBe(204);
  });
  it('concurrent acks of one device: no 5xx; the stored cursor is one of the posted ones', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const cs = [1, 2, 3, 4, 5].map((n) => mkCursor(S.date, [[S.route.id, n]]));
    const rs = await Promise.allSettled(cs.map((c) => ack(ackBody(S.device.id, c), { now: S.now })));
    for (const r of rs) {
      if (r.status === 'fulfilled') expect(r.value.status).toBe(204);
      else expect(['common.version_conflict']).toContain((r.reason as any).code);
    }
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(cs).toContain((await deviceRow(S.device.id)).last_ack_cursor);
  });
});

describe('US-13-5 wipe: pull says wipe -> device uploads, destroys, acks with wipe_completed:true -> wiped', () => {
  it('requested wipe: the pull carries device_command wipe; ack {wipe_completed:true} -> 204, status wiped, wiped_at = server time, version + 1; wipe_requested_* kept', { timeout: T }, async () => {
    const S = await scenario(FILE);
    await wipeRequested(S.device.id);
    const p = await pullS(S);
    expect(p.body.device_command).toBe('wipe');
    const before = await deviceRow(S.device.id);
    const r = await ack(ackBody(S.device.id, p.body.cursor, { wipe_completed: true }), { now: S.now });
    expect(r.status).toBe(204);
    const row = await deviceRow(S.device.id);
    expect(row.status).toBe('wiped');
    expect(new Date(row.wiped_at).getTime()).toBe(S.now.getTime());
    expect(row.version).toBeGreaterThan(before.version);
    expect(row.wipe_requested_at).toEqual(before.wipe_requested_at);
    expect(row.wipe_reason_code).toBe('lost');
    expect(row.membership_id).toBe(MEMBER.a);
  });
  it('wiped is terminal: the next pull, ack and (any) re-ack -> 409 homecollection.device_not_registered', { timeout: T }, async () => {
    const S = await scenario(FILE);
    await wipeRequested(S.device.id);
    const p = await pullS(S);
    await ack(ackBody(S.device.id, p.body.cursor, { wipe_completed: true }), { now: S.now });
    const e1 = await pullFails(S.device.id, { now: S.now });
    expect([e1.code, e1.statusCode]).toEqual(['homecollection.device_not_registered', 409]);
    const e2 = await ackFails(ackBody(S.device.id, p.body.cursor), { now: S.now });
    expect([e2.code, e2.statusCode]).toEqual(['homecollection.device_not_registered', 409]);
    const e3 = await ackFails(ackBody(S.device.id, p.body.cursor, { wipe_completed: true }), { now: S.now });
    expect(e3.code).toBe('homecollection.device_not_registered');
  });
  it('an ordinary ack (no wipe_completed / false) of a wipe_requested device keeps it wipe_requested: the wipe is not undone and wiped_at stays empty', { timeout: T }, async () => {
    const S = await scenario(FILE);
    await wipeRequested(S.device.id);
    const p = await pullS(S);
    for (const b of [ackBody(S.device.id, p.body.cursor), ackBody(S.device.id, p.body.cursor, { wipe_completed: false })]) {
      expect((await ack(b, { now: S.now })).status).toBe(204);
      const row = await deviceRow(S.device.id);
      expect(row.status).toBe('wipe_requested');
      expect(row.wiped_at).toBeNull();
    }
    expect((await pullS(S)).body.device_command).toBe('wipe');   // and the device is told again
  });
  it('a wiped device is not revived by a later pull or ack: status stays wiped', { timeout: T }, async () => {
    const S = await scenario(FILE);
    await wipeRequested(S.device.id);
    const p = await pullS(S);
    await ack(ackBody(S.device.id, p.body.cursor, { wipe_completed: true }), { now: S.now });
    await ackFails(ackBody(S.device.id, p.body.cursor), { now: S.now });
    await pullFails(S.device.id, { now: S.now });
    expect((await deviceRow(S.device.id)).status).toBe('wiped');
  });
});

describe('A4 device binding, versions, validation (US-06-6/7, 07-SECURITY AB1)', () => {
  const refused = async (p: Promise<unknown>, code: string, status: number, d?: any) => {
    const settled = p.then(() => { throw new Error('expected rejection'); }, (x: any) => x);
    const before = d ? frozen(await deviceRow(d.id)) : undefined;
    const e = await settled;
    expect([e.code, e.statusCode]).toEqual([code, status]);
    if (d) expect(frozen(await deviceRow(d.id))).toEqual(before);
    return e;
  };

  it('AB1: PHLEBO2 acking PHLEBO\'s device -> 409 homecollection.device_not_registered; the device and the routes are unchanged', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const routeBefore = (await routeRow(S.route.id)).last_ack_at;
    await refused(ack(ackBody(S.device.id, p.body.cursor), { who: PHLEBO2, now: S.now }), 'homecollection.device_not_registered', 409, S.device);
    expect((await routeRow(S.route.id)).last_ack_at).toEqual(routeBefore);
  });
  it('unknown device, a tenant B device, signed_off device -> 409 homecollection.device_not_registered', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const b = await seedDevice('b');
    const so = await seedDevice('a', { status: 'signed_off', signed_off_at: '2027-03-01T00:00:00Z' });
    await refused(ack(ackBody(v7(), p.body.cursor), { now: S.now }), 'homecollection.device_not_registered', 409);
    await refused(ack(ackBody(b.id, p.body.cursor), { now: S.now }), 'homecollection.device_not_registered', 409, b);
    await refused(ack(ackBody(so.id, p.body.cursor), { now: S.now }), 'homecollection.device_not_registered', 409, so);
  });
  it('device-id header vs body mismatch -> 400 common.id_mismatch [ASSUMED enforced in the handler, as HC-T10]', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    await refused(ack(ackBody(S.device.id, p.body.cursor), { now: S.now, headers: hdr(v7()) }), 'common.id_mismatch', 400, S.device);
  });
  it('permissions: sync.upload is required (NOBODY -> auth.forbidden); nothing changes', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    await refused(ack(ackBody(S.device.id, p.body.cursor), { who: NOBODY, now: S.now }), 'auth.forbidden', 403, S.device);
    await refused(ack(ackBody(S.device.id, p.body.cursor), { who: as(PHLEBO, { grants: [P.read] }), now: S.now }), 'auth.forbidden', 403, S.device);
  });
  it('invalid bodies -> 400 common.validation_failed and no state change: empty / > 512 / non-base64url cursor, negative or fractional seq, bad applied_at_device, non-boolean wipe_completed, unknown field, missing field, tenant_id smuggled in', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const p = await pullS(S);
    const good = ackBody(S.device.id, p.body.cursor);
    const bad: Array<[string, unknown]> = [
      ['empty cursor', { ...good, cursor: '' }], ['cursor 513', { ...good, cursor: 'A'.repeat(513) }], ['cursor charset', { ...good, cursor: 'abc def!' }], ['cursor number', { ...good, cursor: 7 }],
      ['seq -1', { ...good, max_device_seq_acked: -1 }], ['seq 1.5', { ...good, max_device_seq_acked: 1.5 }], ['seq string', { ...good, max_device_seq_acked: '3' }],
      ['applied_at not a date', { ...good, applied_at_device: 'yesterday' }], ['wipe_completed string', { ...good, wipe_completed: 'true' }],
      ['unknown field', { ...good, status: 'wiped' }], ['tenant_id', { ...good, tenant_id: TENANT_B }], ['membership_id', { ...good, membership_id: MEMBER2.a }],
      ['missing cursor', { device_id: good.device_id, applied_at_device: good.applied_at_device, max_device_seq_acked: 0 }], ['missing seq', { device_id: good.device_id, cursor: good.cursor, applied_at_device: good.applied_at_device }],
      ['not an object', 'nope'],
    ];
    const before = frozen(await deviceRow(S.device.id));
    for (const [name, body] of bad) {
      const e = await ack(body, { now: S.now, headers: hdr(S.device.id) }).then(() => { throw new Error(`${name}: expected rejection`); }, (x: any) => x);
      expect([name, e.code, e.statusCode]).toEqual([name, 'common.validation_failed', 400]);
    }
    expect(frozen(await deviceRow(S.device.id))).toEqual(before);
    expect((await routeRow(S.route.id)).last_ack_at).toBeNull();
  });
  it('a 512-char cursor is accepted (boundary) and stored verbatim', { timeout: T }, async () => {
    const S = await scenario(FILE);
    const c = 'A'.repeat(512);
    expect((await ack(ackBody(S.device.id, c), { now: S.now })).status).toBe(204);
    expect((await deviceRow(S.device.id)).last_ack_cursor).toBe(c);
  });
});
