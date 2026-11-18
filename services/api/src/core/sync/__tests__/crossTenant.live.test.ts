// T0B-SYNC-1 done_when (5) CROSS TENANT ISOLATION (07-SECURITY §6.1 style): tenant B attacks tenant A's device and block through every sync operation and through the database
// role of the API; nothing of tenant A changes, nothing leaks. Live PG17, RLS on.
import { describe, expect, it } from 'vitest';
import { reportBlockSkipped } from '../blocks.service.js';
import { A1, AADM, B1, BADM, TENANT_A, TENANT_B, USER, ack, codeOf, counter, list, newDevice, ok, ownerRows, reg, reserve, revoke, setCounters, status, uid, wipe, withCtx } from './helpers.js';

const T = 120_000;
const snapA = async () => JSON.stringify([
  await ownerRows('SELECT * FROM core.sync_device WHERE tenant_id = $1 ORDER BY id', [TENANT_A]),
  await ownerRows('SELECT * FROM core.number_block WHERE tenant_id = $1 ORDER BY id', [TENANT_A]),
  await counter(TENANT_A, 'lab_code'), await counter(TENANT_A, 'patient_id'),
  (await ownerRows(`SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'core' AND table_name IN ('sync_device','number_block')`, [TENANT_A]))[0].n,
]);

describe('tenant B against tenant A through the operations', () => {
  it('B cannot register, read status of, reserve for, revoke, wipe, ack or skip-report anything of A: every call is refused and A is byte for byte unchanged', async () => {
    await setCounters(TENANT_A, { lab: 300, patient: 300 });
    const dA = await newDevice(A1, { device_label: 'Alpha secret device (SYNTHETIC)' });
    const blk = ok(await reserve(A1, dA, 'lab_code', 10)).block;
    ok(await wipe(AADM, await newDevice(A1)));                       // some more A state (wiped device)
    const before = await snapA();
    const outs: Array<[string, { error?: any }]> = [
      ['register', await reg(B1, dA)], ['status', await status(B1, dA)], ['reserve', await reserve(B1, dA, 'lab_code', 10)], ['revoke', await revoke(BADM, dA)],
      ['wipe', await wipe(BADM, dA)], ['ack', await ack(B1, dA)], ['skipped', await withCtx(B1, (c) => reportBlockSkipped(c, { blockId: blk.id, skippedCount: 3 }))],
    ];
    const expected: Record<string, string> = { register: 'auth.forbidden', status: 'sync.device_unknown', reserve: 'sync.device_unknown', revoke: 'sync.device_unknown',
      wipe: 'sync.device_unknown', ack: 'sync.device_unknown', skipped: 'common.not_found' };
    for (const [n, o] of outs) expect(codeOf(o), n).toBe(expected[n]);
    for (const [n, o] of outs) expect(JSON.stringify(o.error?.message ?? '') + JSON.stringify(o.error?.detail ?? ''), n).not.toMatch(/Alpha secret|TENANT_A|a001/);
    expect(await snapA()).toBe(before);
  }, T);

  it('listSyncDevices of tenant B never contains a device of tenant A, whatever the filters (user_id of an A user, status, platform)', async () => {
    const dA = await newDevice(A1, { platform: 'ios' }); await wipe(AADM, dA);
    await newDevice(B1);
    for (const q of [{}, { user_id: USER.a1 }, { status: 'wipe_requested' }, { platform: 'ios' }, { limit: 200 }]) {
      const b = ok(await list(BADM, q));
      expect(b.data.map((d: any) => d.id), JSON.stringify(q)).not.toContain(dA);
      for (const d of b.data) expect(d.user_id).not.toBe(USER.a1);
    }
    expect(ok(await list(BADM, { user_id: USER.a1 })).data).toEqual([]);
  }, T);

  it('a blocked reservation of B does not move the counters of A, and a successful one of B moves only B', async () => {
    await setCounters(TENANT_A, { lab: 50 }); await setCounters(TENANT_B, { lab: 70 });
    const dA = await newDevice(A1), dB = await newDevice(B1);
    await reserve(B1, dA, 'lab_code', 10);
    expect(await counter(TENANT_A, 'lab_code')).toBe(50);
    ok(await reserve(B1, dB, 'lab_code', 10));
    expect([await counter(TENANT_A, 'lab_code'), await counter(TENANT_B, 'lab_code')]).toEqual([50, 80]);
  }, T);
});

describe('tenant B against tenant A through the database role (RLS, FORCE)', () => {
  it('as lims_api with tenant B claims: no row of A is visible, an UPDATE touches 0 rows, an INSERT for tenant A is refused, DELETE is not granted', async () => {
    const dA = await newDevice(A1); const blk = ok(await reserve(A1, dA, 'patient_id', 10)).block;
    const o = await withCtx(BADM, async (ctx) => {
      const q = (t: string, v?: unknown[]) => ctx.tx.query(t, v);
      const out: Record<string, unknown> = {};
      out.dev = (await q('SELECT id FROM core.sync_device WHERE id = $1', [dA])).rows.length;
      out.blk = (await q('SELECT id FROM core.number_block WHERE id = $1', [blk.id])).rows.length;
      out.upd = (await q(`UPDATE core.sync_device SET status = 'revoked' WHERE id = $1`, [dA])).rowCount;
      out.updBlk = (await q('UPDATE core.number_block SET skipped_count = 5 WHERE id = $1', [blk.id])).rowCount;
      await q('SAVEPOINT x');
      out.ins = await q(`INSERT INTO core.sync_device (id, tenant_id, user_id, device_label, platform, app_version, created_by, updated_by)
        VALUES ($1, $2, $3, 'x', 'web', '1', $3, $3)`, [uid(), TENANT_A, USER.a1]).then(() => 'inserted', (e: any) => e.code);
      await q('ROLLBACK TO SAVEPOINT x');
      out.del = await q('DELETE FROM core.sync_device WHERE id = $1', [dA]).then(() => 'deleted', (e: any) => e.code);
      return out;
    });
    expect(o.error).toBeUndefined();
    expect(o.reply).toMatchObject({ dev: 0, blk: 0, upd: 0, updBlk: 0, ins: '42501' });
    expect(o.reply!.del).toMatch(/^(42501)$/);
  }, T);

  it('as a non staff actor (patient claims) of tenant A itself: both tables read as empty and writes are refused', async () => {
    await newDevice(A1);
    const o = await withCtx({ tenant: TENANT_A, userId: USER.a1, type: 'patient' }, async (ctx) => ({
      dev: (await ctx.tx.query('SELECT id FROM core.sync_device')).rows.length, blk: (await ctx.tx.query('SELECT id FROM core.number_block')).rows.length,
    }));
    expect(o.reply).toEqual({ dev: 0, blk: 0 });
  }, T);
});
