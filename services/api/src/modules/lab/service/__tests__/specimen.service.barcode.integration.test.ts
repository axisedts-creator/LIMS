// C5 T-05 — barcode allocation against the migrated database (06 row T-05 "integration (concurrency: 50 parallel allocations unique)"; AC-01.3, AC-01.4; 02-TRD §4.2, §6.1).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (its LIMS_T03_CMD hook runs this file; see .orchestra/notes/C5.T-05-verify.cmd):
//   LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Fixtures: tests/db/c5-t03/fixtures.sql (tenant A counter 5, tenant B no counter row).
// Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// Seam: allocateBarcode(ctx) from ../specimen.service.ts, ctx shape documented in specimen.service.barcode.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { allocateBarcode } from '../specimen.service.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = new Date('2026-06-15T05:00:00Z');
const RE = /^[A-Z0-9]{1,20}$/;

type Numbering = { barcodePattern?: string; barcodePrefix?: string };
let api: pg.Pool;
let admin: pg.Pool;

const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
const sql = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
/** Fixture writes: lab.barcode_counters is audited by C0 row triggers (02-TRD:501) that raise audit_context_missing without claims sub (08-CR A28.5; 03-IC:3230). See C5.T-05-ruling.md. */
const setCounter = async (tenant: string, value: number) => {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    await c.query('UPDATE lab.barcode_counters SET last_value = $1 WHERE tenant_id = $2', [value, tenant]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
};
const counterOf = async (tenant: string): Promise<number | null> => {
  const r = await sql('SELECT last_value FROM lab.barcode_counters WHERE tenant_id = $1', [tenant]);
  return r[0] ? Number(r[0]['last_value']) : null;
};

/** One request-shaped transaction as the real pipeline opens it (claims set transaction-locally); COMMIT on success, ROLLBACK on throw. */
async function inTx<T>(tenantId: string, numbering: Numbering, fn: (ctx: any) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenantId)]);
    const ctx = {
      tenantId, actor: { type: 'system', id: SYS }, tx: client, now: () => NOW,
      ports: { IdentityPort: { getTenantSettings: async () => ({ numbering }) } },
    };
    const out = await fn(ctx);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
const alloc = (tenant: string, numbering: Numbering = { barcodePrefix: 'E' }) => inTx(tenant, numbering, (ctx) => allocateBarcode(ctx));
const failure = async (p: Promise<unknown>): Promise<unknown> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const seqOf = (barcode: string) => Number(barcode.slice(3));   // E26 + 8 digits

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 10 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  const fixtures = readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c5-t03/fixtures.sql', import.meta.url)), 'utf8');
  await admin.query(fixtures);       // fresh migrated + seeded database (run.sh)
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-05 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-05 AC-01.3 allocation on the real counter', () => {
  it('prefix E, counter 41, 2026 -> E2600000042; the counter row ends at 42; matches ^[A-Z0-9]{1,20}$', async () => {
    await setCounter(A, 41);
    const v = await alloc(A);
    expect(v).toBe('E2600000042');
    expect(v).toMatch(RE);
    expect(await counterOf(A)).toBe(42);
  });

  it('first use of a tenant (no counter row) starts at 1 and does not touch the other tenant', async () => {
    expect(await counterOf(B)).toBeNull();
    const before = await counterOf(A);
    expect(await alloc(B)).toBe('E2600000001');
    expect(await alloc(B)).toBe('E2600000002');
    expect(await counterOf(B)).toBe(2);
    expect(await counterOf(A)).toBe(before);
  });

  it('settings drive the result: no prefix -> default pattern without letters; custom pattern is honoured', async () => {
    await setCounter(A, 41);
    expect(await alloc(A, {})).toBe('2600000042');
    expect(await alloc(A, { barcodePattern: 'LAB{seq:4}X' })).toBe('LAB0043X');
    expect(await alloc(A, { barcodePrefix: 'Q9', barcodePattern: '{prefix}{yy}{seq:8}' })).toBe('Q92600000044');
  });
});

describe.skipIf(!live)('T-05 concurrency: unique values under parallel allocation (counter row lock)', () => {
  it('50 parallel allocations in separate transactions -> 50 distinct barcodes, a contiguous range, counter advanced by exactly 50', async () => {
    const start = (await counterOf(A))!;
    const got = await Promise.all(Array.from({ length: 50 }, () => alloc(A)));
    expect(new Set(got).size).toBe(50);
    for (const v of got) expect(v).toMatch(RE);
    const seqs = got.map(seqOf).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => start + 1 + i));
    expect(await counterOf(A)).toBe(start + 50);
  });

  it('two tenants allocating at the same time: each gets its own unique contiguous series', async () => {
    const a0 = (await counterOf(A))!;
    const b0 = (await counterOf(B))!;
    const jobs = Array.from({ length: 40 }, (_, i) => alloc(i % 2 === 0 ? A : B).then((v) => ({ t: i % 2 === 0 ? A : B, v })));
    const got = await Promise.all(jobs);
    for (const [t, base] of [[A, a0], [B, b0]] as const) {
      const seqs = got.filter((g) => g.t === t).map((g) => seqOf(g.v)).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => base + 1 + i));
    }
    expect(await counterOf(A)).toBe(a0 + 20);
    expect(await counterOf(B)).toBe(b0 + 20);
  });

  it('several allocations inside ONE transaction are consecutive and committed together (02-TRD §4.1 step: one barcode per specimen requirement)', async () => {
    const start = (await counterOf(A))!;
    const got = await inTx(A, { barcodePrefix: 'E' }, async (ctx) => [await allocateBarcode(ctx), await allocateBarcode(ctx), await allocateBarcode(ctx)]);
    expect(got.map(seqOf)).toEqual([start + 1, start + 2, start + 3]);
    expect(await counterOf(A)).toBe(start + 3);
  });
});

describe.skipIf(!live)('T-05 AC-01.4 failures are atomic (no counter movement, no specimen)', () => {
  const specimenCount = async () => Number((await sql('SELECT count(*)::int AS n FROM lab.specimens'))[0]!['n']);

  it('invalid pattern -> lab.barcode_pattern_invalid, 500; the transaction rolls back and the counter is unchanged', async () => {
    const before = await counterOf(A);
    const specimens = await specimenCount();
    for (const barcodePattern of ['e{seq:8}', '{branch}{seq:8}', '{centre}{seq:8}', '{fy}{seq:8}', '{fyl}{seq:8}', 'ABCDEFGHIJKLM{seq:8}', "E'; DROP TABLE lab.specimens; --{seq:8}"]) {
      const err = await failure(alloc(A, { barcodePattern }));
      expect(isLimsError(err, 'lab.barcode_pattern_invalid'), barcodePattern).toBe(true);
      expect((err as { statusCode: number }).statusCode).toBe(500);
    }
    expect(await counterOf(A)).toBe(before);
    expect(await specimenCount()).toBe(specimens);
  });

  it('counter overflow (next value has 9 digits, pattern {seq:8}) -> lab.barcode_pattern_invalid and the counter stays at 99999999', async () => {
    await setCounter(A, 99999999);
    const err = await failure(alloc(A));
    expect(isLimsError(err, 'lab.barcode_pattern_invalid')).toBe(true);
    expect(await counterOf(A)).toBe(99999999);
    expect(await alloc(A, { barcodePrefix: 'E', barcodePattern: '{prefix}{yy}{seq:9}' })).toBe('E26100000000');   // wider pattern fits the same value
    await setCounter(A, 1000);
  });

  it('allocation lives in the caller transaction: a later failure in the same tx gives the value back (same-tx S1 guarantee)', async () => {
    const before = (await counterOf(A))!;
    const err = await failure(inTx(A, { barcodePrefix: 'E' }, async (ctx) => { await allocateBarcode(ctx); throw new Error('later step failed'); }));
    expect((err as Error).message).toBe('later step failed');
    expect(await counterOf(A)).toBe(before);
    expect(seqOf(await alloc(A))).toBe(before + 1);
  });

  it('a failed allocation in one transaction does not block or corrupt parallel good ones', async () => {
    const start = (await counterOf(A))!;
    const jobs = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? failure(alloc(A, { barcodePattern: '{branch}{seq:8}' })) : alloc(A)));
    const out = await Promise.all(jobs);
    const good = out.filter((o): o is string => typeof o === 'string');
    expect(good).toHaveLength(16);
    expect(new Set(good).size).toBe(16);
    expect(good.map(seqOf).sort((x, y) => x - y)).toEqual(Array.from({ length: 16 }, (_, i) => start + 1 + i));
  });
});

describe.skipIf(!live)('T-05 tenant isolation (REQ-SEC-024): the ctx tenant alone selects the counter row', () => {
  it('with RLS bypassed (superuser session) an allocation for A still only moves A\'s row', async () => {
    const a0 = (await counterOf(A))!;
    const b0 = (await counterOf(B))!;
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]);   // claims = ctx tenant (audit trigger needs consistent claims, ruling); superuser bypasses RLS, so only the explicit tenant_id filter keeps B untouched
      await client.query("SET LOCAL search_path = ''");
      const ctx = { tenantId: A, actor: { type: 'system', id: SYS }, tx: client, now: () => NOW, ports: { IdentityPort: { getTenantSettings: async () => ({ numbering: { barcodePrefix: 'E' } }) } } };
      expect(seqOf(await allocateBarcode(ctx as never))).toBe(a0 + 1);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await counterOf(A)).toBe(a0 + 1);
    expect(await counterOf(B)).toBe(b0);
  });
});
