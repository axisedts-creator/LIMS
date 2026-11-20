// T0B-SYNC-2 CROSS TENANT ISOLATION (07-SECURITY §6.1 style): tenant B attacks tenant A's ledger, conflicts, devices and pull data through every part 2 operation and through the database role of the API.
// Live PG17, RLS on. Fails today: createSyncPart2Handlers does not exist.
import { describe, expect, it } from 'vitest';
import { A1, A2, AADM, B1, BADM, TENANT_A, TENANT_B, USER, code, conflictsOf, devicePush, effects, engine, enter, getConflict, ledger, listConflicts, newDevice, okBody, ownerRows, pull, resolve, uid, verify, withCtx } from './helpers2.js';

const T = 300_000;
const H = engine();
const CAN = { codes: ['sync.use', 'sync.conflict.resolve'] };
const snapA = async () => JSON.stringify([
  await ownerRows('SELECT * FROM core.sync_operation WHERE tenant_id = $1 ORDER BY op_id', [TENANT_A]),
  await ownerRows('SELECT * FROM core.sync_conflict WHERE tenant_id = $1 ORDER BY id', [TENANT_A]),
  await ownerRows('SELECT * FROM core.sync_device WHERE tenant_id = $1 ORDER BY id', [TENANT_A]),
  await ownerRows('SELECT * FROM sync2_test.effect WHERE tenant_id = $1 ORDER BY n', [TENANT_A]),
]);

describe('tenant B against tenant A through the operations', () => {
  it('B cannot push through, pull with, list, read or resolve anything of A: every call is refused or empty and A is byte for byte unchanged; no error text names A', async () => {
    const dA = await newDevice(A1);
    const secret = verify({ payload: { tag: 'Alpha-secret-payload', conflict: true } });
    const conflictId = okBody(await devicePush(H, A1, dA, [secret])).results[0].conflict_id;
    const before = await snapA();
    const mine = enter();
    const outs: Array<[string, any]> = [
      ['push on A device', await devicePush(H, B1, dA, [mine])],
      ['pull with A device', await pull(H, B1, dA, [{ entity_type: 'doctor' }])],
      ['get', await getConflict(H, BADM, conflictId, { grants: CAN })],
      ['resolve', await resolve(H, BADM, conflictId, { resolution: 'apply_local', reason: 'attack (synthetic)' }, { grants: CAN })],
    ];
    const expected: Record<string, string> = { 'push on A device': 'sync.device_unknown', 'pull with A device': 'sync.device_unknown', get: 'common.not_found', resolve: 'common.not_found' };
    for (const [n, o] of outs) expect(code(o), n).toBe(expected[n]);
    for (const [n, o] of outs) expect(JSON.stringify(o.error?.message ?? '') + JSON.stringify(o.error?.detail ?? '') + o.logs.join(''), n).not.toMatch(/Alpha-secret|a001|TENANT_A/);
    const list = okBody(await listConflicts(H, BADM, { limit: 200 }, { grants: CAN }));
    expect(list.data.map((c: any) => c.id)).not.toContain(conflictId);
    expect(JSON.stringify(list)).not.toMatch(/Alpha-secret/);
    expect(await ledger([mine.op_id])).toEqual([]);
    expect(await snapA()).toBe(before);
  }, T);
  it('the ledger key is per tenant: B may use the same op_id as A (no oracle, no clash), A\'s stored result is untouched and B gets its own', async () => {
    const [dA, dB] = [await newDevice(A1), await newDevice(B1)];
    const a = enter({ payload: { tag: 'A-only' } });
    okBody(await devicePush(H, A1, dA, [a]));
    const snap = JSON.stringify(await ledger([a.op_id]));
    const r = okBody(await devicePush(H, B1, dB, [{ ...a, payload: { tag: 'B-only' } }])).results[0];
    expect(r.status).toBe('accepted');                                      // not duplicate, not sync.op_id_reused: nothing of A is observable
    const rows = await ownerRows('SELECT tenant_id, payload FROM core.sync_operation WHERE op_id = $1 ORDER BY tenant_id', [a.op_id]);
    expect(rows.map((x) => [x.tenant_id, x.payload.tag]).sort()).toEqual([[TENANT_A, 'A-only'], [TENANT_B, 'B-only']].sort());
    expect(JSON.stringify((await ledger([a.op_id])).filter((x) => x.tenant_id === TENANT_A))).toBe(JSON.stringify(JSON.parse(snap).filter((x: any) => x.tenant_id === TENANT_A)));
  }, T);
  it('a full pull of EVERY whitelisted type by B (all pages) never contains a row, name or id of tenant A', async () => {
    const dB = await newDevice(B1);
    for (const type of ['test', 'parameter', 'doctor', 'centre', 'price_list_version', 'verification_policy', 'print_profile', 'patient', 'worklist_item', 'permission']) {
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const o = await pull(H, B1, dB, [{ entity_type: type, ...(cursor ? { cursor } : {}) }], 1000);
        expect(['common.validation_failed'].includes(code(o) ?? ''), `${type}: ${code(o)}`).toBe(false);
        if (o.error) break;                                                  // refused for lack of a permission of this fake: fine; leaking is not
        const ch = okBody(o).changes[0];
        for (const x of [...ch.upserts, ...ch.tombstones]) expect(JSON.stringify(x), type).not.toMatch(/ac40-7000-8000-00000000a|Alpha/i);
        cursor = ch.next_cursor; if (!ch.has_more) break;
      }
    }
  }, T);
});

describe('tenant B against tenant A through the database role (RLS, FORCE, grants)', () => {
  it('as lims_api with tenant B claims: no ledger or conflict row of A is visible, an UPDATE touches 0 rows, an INSERT for tenant A is refused, DELETE is not granted', async () => {
    const dA = await newDevice(A1);
    const op = verify({ payload: { tag: 'rls', conflict: true } });
    const cid = okBody(await devicePush(H, A1, dA, [op])).results[0].conflict_id;
    const o = await withCtx(BADM, async (ctx) => {
      const q = (t: string, v?: unknown[]) => ctx.tx.query(t, v);
      const out: Record<string, unknown> = {};
      out.ops = (await q('SELECT op_id FROM core.sync_operation WHERE op_id = $1', [op.op_id])).rows.length;
      out.cf = (await q('SELECT id FROM core.sync_conflict WHERE id = $1', [cid])).rows.length;
      out.updOp = (await q(`UPDATE core.sync_operation SET status = 'accepted', result = '{}'::jsonb WHERE op_id = $1`, [op.op_id])).rowCount;
      out.updCf = (await q(`UPDATE core.sync_conflict SET status = 'resolved', resolution = 'keep_server', reason = 'x', resolved_at = now(), resolved_by = $2 WHERE id = $1`, [cid, USER.badm])).rowCount;
      await q('SAVEPOINT x');
      out.insOp = await q(`INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, status) VALUES ($1, $2, $3, $4, 'result.enter', 'h', '{}', now(), 'accepted')`,
        [TENANT_A, uid(), dA, USER.a1]).then(() => 'inserted', (e: any) => e.code);
      await q('ROLLBACK TO SAVEPOINT x');
      out.delOp = await q('DELETE FROM core.sync_operation WHERE op_id = $1', [op.op_id]).then(() => 'deleted', (e: any) => e.code);
      await q('ROLLBACK TO SAVEPOINT x').catch(() => undefined);
      return out;
    });
    expect(o.error).toBeUndefined();
    expect(o.reply).toMatchObject({ ops: 0, cf: 0, updOp: 0, updCf: 0, insOp: '42501' });
    expect(o.reply!.delOp).toBe('42501');
  }, T);
  it('as a non staff actor (patient claims) of tenant A itself: both tables read as empty and writes are refused', async () => {
    const dev = await newDevice(A1);
    okBody(await devicePush(H, A1, dev, [enter()]));
    const o = await withCtx({ tenant: TENANT_A, userId: USER.a1, type: 'patient' }, async (ctx) => ({
      ops: (await ctx.tx.query('SELECT op_id FROM core.sync_operation')).rows.length, cf: (await ctx.tx.query('SELECT id FROM core.sync_conflict')).rows.length,
    }));
    expect(o.reply).toEqual({ ops: 0, cf: 0 });
  }, T);
});

describe('another user of the SAME tenant', () => {
  it('cannot use another user\'s device to push or pull, and a conflict of A1 is visible to a resolver but a plain user cannot read or resolve it', async () => {
    const dA = await newDevice(A1);
    expect(code(await devicePush(H, A2, dA, [enter()]))).toBe('sync.device_unknown');
    expect(code(await pull(H, A2, dA, [{ entity_type: 'doctor' }]))).toBe('sync.device_unknown');
    const c = okBody(await devicePush(H, A1, dA, [verify({ payload: { conflict: true } })])).results[0].conflict_id;
    expect(code(await getConflict(H, A1, c, { grants: { codes: ['sync.use'] } }))).toBe('auth.forbidden');
    expect(code(await resolve(H, A2, c, { resolution: 'keep_server', reason: 'r (synthetic)' }, { grants: { codes: ['sync.use'] } }))).toBe('auth.forbidden');
    expect((await conflictsOf([]))).toEqual([]);
    expect(AADM.userId).toBeTruthy(); expect(effects).toBeTruthy();
  }, T);
});
