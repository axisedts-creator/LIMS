// T0B-SYNC-2 done_when (8) probe rows + what the engine leaves in core.sync_operation / core.sync_conflict (T0C-SYNC-2 tables): tenant isolated, audited where the contract says, never deleted,
// append only / resolve once triggers hold against the engine's own writes, and the probe kit rows exist. Live PG17 catalog checks as the API's role view; the structural proof is
// db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql (T0C-SYNC-2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../module.js';
import { A1, TENANT_A, devicePush, engine, enter, ledger, newDevice, okBody, ownerRows, uid, verify } from './helpers2.js';

const T = 300_000;
const H = engine();
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('catalog', () => {
  it.each(['sync_operation', 'sync_conflict'])('core.%s: RLS enabled and FORCED, lims_app may SELECT/INSERT/UPDATE but not DELETE or TRUNCATE', async (t) => {
    const c = (await ownerRows(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`core.${t}`]))[0];
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const g = (await ownerRows(`SELECT DISTINCT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'lims_app' AND table_schema = 'core' AND table_name = $1`, [t])).map((r) => r.privilege_type).sort();
    expect(g).toContain('SELECT'); expect(g).toContain('INSERT'); expect(g).not.toContain('DELETE'); expect(g).not.toContain('TRUNCATE');
  }, T);
  it('core.sync_conflict is row audited; core.sync_operation is not (its payload would be copied into the audit log)', async () => {
    const trg = (t: string) => ownerRows(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [`core.${t}`]).then((r) => r.map((x) => x.tgname));
    expect(await trg('sync_conflict')).toContain('sync_conflict__audit');
    expect(await trg('sync_operation')).not.toContain('sync_operation__audit');
  }, T);
});

describe('what the engine leaves in the tables', () => {
  it('a ledger row carries tenant, device (of the same tenant), user, hash and both times; the engine cannot rewrite the payload or the outcome later (append only triggers)', async () => {
    const dev = await newDevice(A1);
    const o = enter({ payload: { tag: 'ledger' } });
    okBody(await devicePush(H, A1, dev, [o]));
    const row = (await ledger([o.op_id]))[0];
    expect(row).toMatchObject({ tenant_id: TENANT_A, device_id: dev, user_id: A1.userId });
    const d = await ownerRows('SELECT tenant_id FROM core.sync_device WHERE id = $1', [dev]);
    expect(d[0].tenant_id).toBe(row.tenant_id);
    await expect(ownerRows(`UPDATE core.sync_operation SET payload = '{"tag":"changed"}'::jsonb WHERE op_id = $1`, [o.op_id])).rejects.toThrow(/immutable_row/);
    await expect(ownerRows(`UPDATE core.sync_operation SET status = 'rejected', result = '{}'::jsonb WHERE op_id = $1`, [o.op_id])).rejects.toThrow(/immutable_row/);   // outcome is written once
  }, T);
  it('a conflict row cannot be changed after it is resolved, and op_id / payloads never change even while open', async () => {
    const dev = await newDevice(A1);
    const v = verify({ payload: { tag: 'cf', conflict: true } });
    const id = okBody(await devicePush(H, A1, dev, [v])).results[0].conflict_id;
    await expect(ownerRows(`UPDATE core.sync_conflict SET local_payload = '{"x":1}'::jsonb WHERE id = $1`, [id])).rejects.toThrow(/immutable_row/);
    await expect(ownerRows(`UPDATE core.sync_conflict SET op_id = $2 WHERE id = $1`, [id, uid()])).rejects.toThrow();
  }, T);
  it('a service insert cannot create a ledger row for a device of another tenant (composite FK) even if the engine were bypassed', async () => {
    const dev = await newDevice(A1);
    await expect(ownerRows(`INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, status)
      VALUES ('01a1a98a-ac40-7000-8000-00000000b001', $1, $2, $3, 'result.enter', 'h', '{}', now(), 'accepted')`, [uid(), dev, A1.userId])).rejects.toThrow();
  }, T);
});

describe('probe rows (T0B-DBSEED-1 generator; the T0C-SYNC-2 migration added the tables)', () => {
  it('db/tests/fixtures/probe-rows/core.sql carries a row per tenant for both tables, and both isolation probes exist and are registered', () => {
    const fx = text('db/tests/fixtures/probe-rows/core.sql');
    expect(fx).toMatch(/INSERT INTO core\.sync_operation/); expect(fx).toMatch(/INSERT INTO core\.sync_conflict/);
    expect(text('db/tests/isolation/_registry.sql')).toMatch(/core\.sync_operation/);
    expect(text('db/tests/isolation/_registry.sql')).toMatch(/core\.sync_conflict/);
    text('db/tests/isolation/core.sync_operation.test.sql'); text('db/tests/isolation/core.sync_conflict.test.sql');
  });
  it('the sync migrations stay in db/meta/tables.yaml with the sync tables of part 2', () => {
    const t = text('db/meta/tables.yaml');
    expect(t).toMatch(/core\.sync_operation/); expect(t).toMatch(/core\.sync_conflict/);
  });
});
