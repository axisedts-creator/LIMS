// T0B-SYNC-1 done_when (5)/(6): the two new tables are tenant isolated, audited, never deleted, and their probe rows exist (db/tests/fixtures/probe-rows/core.sql, db/tests/isolation).
// Live PG17 catalog checks as the API's own role view; the full structural proof is the pgTAP suite db/tests/core/T0C-SYNC-1_sync_devices_blocks.test.sql (T0C-SYNC-1).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../module.js';
import { A1, TENANT_A, newDevice, ok, ownerRows, reserve, setCounters, uid } from './helpers.js';

const T = 120_000;
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('catalog', () => {
  it.each(['sync_device', 'number_block'])('core.%s: RLS enabled and FORCED, audit trigger present, lims_app may SELECT/INSERT/UPDATE but not DELETE or TRUNCATE', async (t) => {
    const c = (await ownerRows(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`core.${t}`]))[0];
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const trg = await ownerRows(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [`core.${t}`]);
    expect(trg.map((r) => r.tgname)).toContain(`${t}__audit`);
    const g = (await ownerRows(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'lims_app' AND table_schema = 'core' AND table_name = $1`, [t])).map((r) => r.privilege_type).sort();
    expect(g).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  }, T);

  it('core.number_block: the overlap trigger and the series CHECK are in place (only lab_code and patient_id)', async () => {
    const trg = (await ownerRows(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'core.number_block'::regclass AND NOT tgisinternal`)).map((r) => r.tgname);
    expect(trg).toContain('number_block__no_overlap');
    const def = (await ownerRows(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'core.number_block'::regclass AND conname = 'number_block__series__ck'`))[0]!.d as string;
    expect(def).toMatch(/lab_code/); expect(def).toMatch(/patient_id/); expect(def).not.toMatch(/bill|invoice|receipt/);
  }, T);
});

describe('what the service leaves in the tables', () => {
  it('rows written by the service carry the tenant, the actor and a valid range; a block never leaves its tenant\'s device', async () => {
    await setCounters(TENANT_A, { lab: 0 });
    const dev = await newDevice(A1);
    const b = ok(await reserve(A1, dev, 'lab_code', 10)).block;
    const rows = await ownerRows(`SELECT b.tenant_id AS bt, d.tenant_id AS dt, b.from_value, b.to_value, b.created_by FROM core.number_block b JOIN core.sync_device d ON d.id = b.device_id WHERE b.id = $1`, [b.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bt).toBe(rows[0]!.dt);
    expect(Number(rows[0]!.to_value) - Number(rows[0]!.from_value) + 1).toBe(10);
  }, T);

  it('a service insert cannot create a block for a device of another tenant (composite FK) even if the service were bypassed', async () => {
    const dev = await newDevice(A1);
    await expect(ownerRows(`INSERT INTO core.number_block (id, tenant_id, device_id, series, from_value, to_value, created_by, updated_by)
      VALUES ($1, '01a1a98a-ac40-7000-8000-00000000b001', $2, 'lab_code', 900000, 900010, $3, $3)`, [uid(), dev, A1.userId])).rejects.toThrow();
  }, T);
});

describe('probe rows (T0B-DBSEED-1 generator; the T0C-SYNC-1 migration added the tables)', () => {
  it('db/tests/fixtures/probe-rows/core.sql carries a row per tenant for both tables, and both isolation probes exist and are registered', () => {
    const fx = text('db/tests/fixtures/probe-rows/core.sql');
    expect(fx).toMatch(/INSERT INTO core\.sync_device/); expect(fx).toMatch(/INSERT INTO core\.number_block/);
    expect(text('db/tests/isolation/_registry.sql')).toMatch(/core\.sync_device/);
    expect(text('db/tests/isolation/_registry.sql')).toMatch(/core\.number_block/);
    text('db/tests/isolation/core.sync_device.test.sql'); text('db/tests/isolation/core.number_block.test.sql');
  });
});
