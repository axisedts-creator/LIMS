// T0B-SYNC-2 done_when (5) CONFLICTS: a stale base_version creates a core.sync_conflict row with both payloads and answers conflict; list / get / resolve (keep_server, apply_local, merge) with a
// reason, through the adapter (the same domain rules as an online edit), audited, resolved ONCE only. Live PG17, RLS on. Fails today: createSyncPart2Handlers does not exist.
import { describe, expect, it } from 'vitest';
import { A1, A2, AADM, B1, BADM, TENANT_A, USER, code, conflictsOf, devicePush, effects, engine, enter, getConflict, ledger, listConflicts, newDevice, NOW, okBody, ownerRows, resolve, serverStates, uid, verify } from './helpers2.js';

const T = 300_000;
const H = engine();
const CAN = { codes: ['sync.use', 'sync.conflict.resolve'] };
/** One conflict made by `A1` through a real push: returns { conflictId, opId, entityId, op }. */
async function makeConflict(tag = 'local', who = A1, extra: Record<string, unknown> = {}) {
  const dev = await newDevice(who);
  const o = verify({ payload: { tag, conflict: true, ...extra } });
  const r = okBody(await devicePush(H, who, dev, [o])).results[0];
  return { r, conflictId: r.conflict_id as string, opId: o.op_id, entityId: o.entity_id!, op: o };
}

describe('a stale base_version becomes a conflict for a person (done_when 5)', () => {
  it('the push answers conflict + sync.base_version_stale + conflict_id; the conflict row holds BOTH payloads, the entity type and the pusher; nothing was applied', async () => {
    const { r, op, conflictId } = await makeConflict('L1');
    expect(r).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale', entity_id: op.entity_id });
    expect(conflictId).toMatch(/^[0-9a-f-]{36}$/);
    const c = (await conflictsOf([op.op_id]))[0];
    expect(c).toMatchObject({ id: conflictId, tenant_id: TENANT_A, op_id: op.op_id, entity_type: 'result', entity_id: op.entity_id, status: 'open', created_by: USER.a1, resolution: null, resolved_by: null });
    expect(c.local_payload).toMatchObject({ tag: 'L1' });
    expect(c.server_payload).toEqual({ status: 'verified', version: 4 });
    expect((await ledger([op.op_id]))[0]).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale' });
    expect(await effects([op.op_id])).toEqual([]);
  }, T);
  it('a replay of the operation answers duplicate with the same conflict_id and never creates a second conflict', async () => {
    const { op, conflictId } = await makeConflict();
    const dev = await newDevice(A1);
    const again = okBody(await devicePush(H, A1, dev, [op])).results[0];
    expect(again).toMatchObject({ status: 'duplicate', conflict_id: conflictId, error_code: 'sync.base_version_stale' });
    expect(await conflictsOf([op.op_id])).toHaveLength(1);
  }, T);
  it('without a base_version problem (adapter reports none) there is no conflict row', async () => {
    const dev = await newDevice(A1);
    const o = verify({ payload: { tag: 'fine' } });
    expect(okBody(await devicePush(H, A1, dev, [o])).results[0].status).toBe('accepted');
    expect(await conflictsOf([o.op_id])).toEqual([]);
  }, T);
  it('a conflict does not stop the batch: the other operations are applied', async () => {
    const dev = await newDevice(A1);
    const [a, b, c] = [enter({ payload: { tag: 'a' } }), verify({ payload: { tag: 'b', conflict: true } }), enter({ payload: { tag: 'c' } })];
    expect(okBody(await devicePush(H, A1, dev, [a, b, c])).results.map((r: any) => r.status)).toEqual(['accepted', 'conflict', 'accepted']);
  }, T);
});

describe('list and get (permission sync.conflict.resolve)', () => {
  it('list: open first, filters by status and entity_type, keyset pages with a cursor, both payloads present, tenant scoped', async () => {
    const c1 = await makeConflict('l1'), c2 = await makeConflict('l2'), c3 = await makeConflict('l3');
    okBody(await resolve(H, AADM, c1.conflictId, { resolution: 'keep_server', reason: 'Server copy is newer (synthetic)' }, { grants: CAN }));
    const open = okBody(await listConflicts(H, AADM, { status: 'open', limit: 200 }, { grants: CAN }));
    const openIds = open.data.map((c: any) => c.id);
    expect(openIds).toEqual(expect.arrayContaining([c2.conflictId, c3.conflictId])); expect(openIds).not.toContain(c1.conflictId);
    expect(open.data.every((c: any) => c.status === 'open')).toBe(true);
    const res = okBody(await listConflicts(H, AADM, { status: 'resolved', limit: 200 }, { grants: CAN }));
    expect(res.data.map((c: any) => c.id)).toContain(c1.conflictId);
    const mine = open.data.find((c: any) => c.id === c2.conflictId);
    expect(mine).toMatchObject({ op_id: c2.opId, entity_type: 'result', entity_id: c2.entityId, status: 'open' });
    expect(mine.local_payload).toMatchObject({ tag: 'l2' }); expect(mine.server_payload).toEqual({ status: 'verified', version: 4 });
    expect(okBody(await listConflicts(H, AADM, { entity_type: 'patient', limit: 200 }, { grants: CAN })).data.map((c: any) => c.id)).not.toContain(c2.conflictId);
    expect(okBody(await listConflicts(H, AADM, { entity_type: 'result', limit: 200 }, { grants: CAN })).data.map((c: any) => c.id)).toContain(c2.conflictId);
    // paging: pages of 2 walk every open conflict exactly once
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const p = okBody(await listConflicts(H, AADM, { status: 'open', limit: 2, ...(cursor ? { cursor } : {}) }, { grants: CAN }));
      expect(p.data.length).toBeLessThanOrEqual(2); seen.push(...p.data.map((c: any) => c.id));
      cursor = p.page.next_cursor; if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([c2.conflictId, c3.conflictId]));
  }, T);
  it('list rejects an unknown status, an unknown entity_type shape, limit 0 / 201 and a garbage cursor', async () => {
    for (const q of [{ status: 'closed' }, { entity_type: 'Patient; --' }, { limit: 0 }, { limit: 201 }]) expect(code(await listConflicts(H, AADM, q, { grants: CAN })), JSON.stringify(q)).toBe('common.validation_failed');
    expect(code(await listConflicts(H, AADM, { cursor: 'garbage!!' }, { grants: CAN }))).toBe('common.invalid_cursor');
  }, T);
  it('get returns the SyncConflict; an unknown id and an id of another tenant are common.not_found; no permission is auth.forbidden', async () => {
    const c = await makeConflict('g1');
    const got = okBody(await getConflict(H, AADM, c.conflictId, { grants: CAN }));
    expect(got).toMatchObject({ id: c.conflictId, op_id: c.opId, entity_type: 'result', entity_id: c.entityId, status: 'open' });
    expect(Object.keys(got).every((k) => ['id', 'op_id', 'entity_type', 'entity_id', 'local_payload', 'server_payload', 'status', 'resolution', 'resolved_by', 'resolved_at', 'reason', 'created_at'].includes(k))).toBe(true);
    expect(code(await getConflict(H, AADM, uid(), { grants: CAN }))).toBe('common.not_found');
    expect(code(await getConflict(H, BADM, c.conflictId, { grants: CAN }))).toBe('common.not_found');
    expect(code(await getConflict(H, AADM, c.conflictId, { grants: { codes: ['sync.use'] } }))).toBe('auth.forbidden');
    expect(code(await listConflicts(H, AADM, {}, { grants: { codes: ['sync.use'] } }))).toBe('auth.forbidden');
    expect(code(await getConflict(H, { ...AADM, type: 'patient' }, c.conflictId, { grants: CAN }))).toBe('auth.forbidden');
  }, T);
});

describe('resolve (done_when 5)', () => {
  it('keep_server: resolved with resolver, time, reason; the local version is discarded (the adapter applies nothing)', async () => {
    const c = await makeConflict('k1');
    const out = okBody(await resolve(H, AADM, c.conflictId, { resolution: 'keep_server', reason: 'Server copy is newer (synthetic)' }, { grants: CAN }));
    expect(out).toMatchObject({ id: c.conflictId, status: 'resolved', resolution: 'keep_server', resolved_by: USER.aadm, reason: 'Server copy is newer (synthetic)' });
    expect(new Date(out.resolved_at).toISOString()).toBe(NOW.toISOString());
    expect(await effects([c.opId])).toEqual([]);
    expect((await conflictsOf([c.opId]))[0]).toMatchObject({ status: 'resolved', resolution: 'keep_server', resolved_by: USER.aadm });
  }, T);
  it('apply_local: the adapter applies the LOCAL payload with the conflict id as idempotency key, as the resolver', async () => {
    const c = await makeConflict('L2');
    okBody(await resolve(H, AADM, c.conflictId, { resolution: 'apply_local', reason: 'Device copy is right (synthetic)' }, { grants: CAN }));
    const fx = await effects([c.opId]);
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ tag: 'resolved:apply_local:L2', entity_id: c.entityId, actor_id: USER.aadm, idempotency_key: c.conflictId });
  }, T);
  it('merge: the merged payload (required) is applied through the adapter; it is refused for the other resolutions and when missing or not an object', async () => {
    const c = await makeConflict('L3');
    const base = { reason: 'Took the new phone number (synthetic)' };
    expect(code(await resolve(H, AADM, c.conflictId, { resolution: 'merge', ...base }, { grants: CAN }))).toBe('common.validation_failed');
    expect(code(await resolve(H, AADM, c.conflictId, { resolution: 'merge', merged_payload: 'x', ...base }, { grants: CAN }))).toBe('common.validation_failed');
    expect(code(await resolve(H, AADM, c.conflictId, { resolution: 'merge', merged_payload: [1], ...base }, { grants: CAN }))).toBe('common.validation_failed');
    expect(code(await resolve(H, AADM, c.conflictId, { resolution: 'keep_server', merged_payload: { a: 1 }, ...base }, { grants: CAN }))).toBe('common.validation_failed');
    expect(code(await resolve(H, AADM, c.conflictId, { resolution: 'apply_local', merged_payload: { a: 1 }, ...base }, { grants: CAN }))).toBe('common.validation_failed');
    expect((await conflictsOf([c.opId]))[0].status).toBe('open');            // every refusal left it open
    okBody(await resolve(H, AADM, c.conflictId, { resolution: 'merge', merged_payload: { tag: 'M' }, ...base }, { grants: CAN }));
    expect((await effects([c.opId]))[0]).toMatchObject({ tag: 'resolved:merge:M', idempotency_key: c.conflictId });
  }, T);
  it('a reason is always required (missing, empty, over 1000) and the resolution must be one of the three', async () => {
    const c = await makeConflict();
    for (const b of [{ resolution: 'keep_server' }, { resolution: 'keep_server', reason: '' }, { resolution: 'keep_server', reason: 'x'.repeat(1001) }, { resolution: 'delete', reason: 'r' }, { reason: 'r' }, { resolution: 'keep_server', reason: 'r', extra: 1 }])
      expect(code(await resolve(H, AADM, c.conflictId, b, { grants: CAN })), JSON.stringify(b).slice(0, 50)).toBe('common.validation_failed');
    expect((await conflictsOf([c.opId]))[0].status).toBe('open');
  }, T);
  it('domain rules apply as for an online edit: when the adapter refuses (e.g. result locked) the resolution fails with that code and the conflict stays open, with no effect', async () => {
    const c = await makeConflict('L4');
    const o = await resolve(H, AADM, c.conflictId, { resolution: 'merge', merged_payload: { tag: 'M', fail: 'lab.result_locked' }, reason: 'try (synthetic)' }, { grants: CAN });
    expect(code(o)).toBe('lab.result_locked');
    expect((await conflictsOf([c.opId]))[0]).toMatchObject({ status: 'open', resolution: null });
    expect(await effects([c.opId])).toEqual([]);
  }, T);
  it('a conflict can be resolved ONCE only: the second resolution (same or other, even by another resolver) is common.immutable_record and changes nothing', async () => {
    const c = await makeConflict('L5');
    okBody(await resolve(H, AADM, c.conflictId, { resolution: 'keep_server', reason: 'first (synthetic)' }, { grants: CAN }));
    const snap = JSON.stringify(await conflictsOf([c.opId]));
    for (const b of [{ resolution: 'keep_server', reason: 'again (synthetic)' }, { resolution: 'apply_local', reason: 'flip (synthetic)' }]) {
      expect(code(await resolve(H, A2, c.conflictId, b, { grants: CAN }))).toBe('common.immutable_record');
    }
    expect(JSON.stringify(await conflictsOf([c.opId]))).toBe(snap);
    expect(await effects([c.opId])).toEqual([]);
  }, T);
  it('two resolutions at the same time: exactly one wins, the other is common.immutable_record, one effect at most', async () => {
    const c = await makeConflict('L6');
    const [x, y] = await Promise.all([
      resolve(H, AADM, c.conflictId, { resolution: 'apply_local', reason: 'one (synthetic)' }, { grants: CAN }),
      resolve(H, A2, c.conflictId, { resolution: 'apply_local', reason: 'two (synthetic)' }, { grants: CAN }),
    ]);
    expect([x, y].filter((o) => !o.error)).toHaveLength(1);
    expect([x, y].filter((o) => o.error).map(code)).toEqual(['common.immutable_record']);
    expect(await effects([c.opId])).toHaveLength(1);
  }, T);
  it('the entity changed on the server after the conflict was recorded: sync.entity_changed, still open, nothing applied; after reloading (server state back) it resolves', async () => {
    const c = await makeConflict('L7');
    serverStates.set(c.entityId, { status: 'released', version: 5 });
    const o = await resolve(H, AADM, c.conflictId, { resolution: 'apply_local', reason: 'r (synthetic)' }, { grants: CAN });
    expect(code(o)).toBe('sync.entity_changed');
    expect((await conflictsOf([c.opId]))[0].status).toBe('open'); expect(await effects([c.opId])).toEqual([]);
    serverStates.delete(c.entityId);
    okBody(await resolve(H, AADM, c.conflictId, { resolution: 'apply_local', reason: 'r (synthetic)' }, { grants: CAN }));
  }, T);
  it('needs sync.conflict.resolve and a staff user; unknown id and another tenant\'s id are common.not_found', async () => {
    const c = await makeConflict('L8');
    const body = { resolution: 'keep_server', reason: 'r (synthetic)' };
    expect(code(await resolve(H, AADM, c.conflictId, body, { grants: { codes: ['sync.use'] } }))).toBe('auth.forbidden');
    expect(code(await resolve(H, { ...AADM, type: 'patient' }, c.conflictId, body, { grants: CAN }))).toBe('auth.forbidden');
    expect(code(await resolve(H, AADM, uid(), body, { grants: CAN }))).toBe('common.not_found');
    expect(code(await resolve(H, BADM, c.conflictId, body, { grants: CAN }))).toBe('common.not_found');
    expect((await conflictsOf([c.opId]))[0].status).toBe('open');
  }, T);
  it('the resolution is audited: the audit log has the update of core.sync_conflict by the resolver with the request id, and carries no payload text of the entity', async () => {
    const c = await makeConflict('L9-audit-marker');
    const before = (await ownerRows(`SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'core' AND table_name = 'sync_conflict'`, [TENANT_A]))[0].n;
    const o = await resolve(H, AADM, c.conflictId, { resolution: 'keep_server', reason: 'audited (synthetic)' }, { grants: CAN });
    okBody(o);
    const rows = await ownerRows(`SELECT * FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'core' AND table_name = 'sync_conflict' ORDER BY 1 DESC LIMIT 5`, [TENANT_A]);
    expect(rows.length).toBeGreaterThan(0);
    expect((await ownerRows(`SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'core' AND table_name = 'sync_conflict'`, [TENANT_A]))[0].n).toBeGreaterThan(before);
    expect(JSON.stringify(rows)).toContain(o.requestId);
    expect(o.logs.join('\n')).not.toMatch(/audit-marker|audited \(synthetic\)/);          // reason and payloads are never logged
  }, T);
});
export { B1 };
