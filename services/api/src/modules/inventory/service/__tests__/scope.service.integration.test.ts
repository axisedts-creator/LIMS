// C12.T-04 scope.service, integration: the REAL T-03 repositories on the migrated database as role lims_api with RLS on (AC-22.1/22.2, 07-SECURITY P-B1, P-B2, P-B3, P-B8, P-T1).
// Same harness as T-03: tests/db/c12-t04/run.sh starts the pinned image, migrates, seeds and exports LIMS_TEST_DATABASE_URL (lims_api) / LIMS_TEST_ADMIN_DATABASE_URL (superuser).
// Fixtures: tests/db/c12-t03/fixtures.sql (applied here once). Used rows: tenant A stores 1001 MAIN-A, 1002 BENCH-A (branch a101), transfer 8701 (1001 -> 1002);
//   tenant B store 1101 (branch b101), transfer 8801 (1101 -> 1102).
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// Seams: see scope.service.test.ts (assertStoreAccess(ctx, storeId, permission), assertTransferAccess(ctx, transferId, { permission, end? }), listVisibleBranchIds(ctx));
//   ctx = { tenantId, actor: { id }, tx, ports: { IdentityPort } } where tx is the request transaction (claims set transaction-locally, like core/db/tx.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { assertStoreAccess, assertTransferAccess, listVisibleBranchIds } from '../scope.service.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const BRANCH_A = '01a1a98a-ac40-7000-8000-00000000a101';
const BRANCH_B = '01a1a98a-ac40-7000-8000-00000000b101';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const STOCK = 'inventory.stock.manage';
const READ = 'inventory.item.read';

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 4 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-04 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Profile { all?: boolean; branchIds?: string[]; permissions?: string[] }
/** One request-shaped transaction as `tenantId`, with an IdentityPort stub for the actor profile; ROLLBACK at the end (read-only checks). */
async function asActor<T>(tenantId: string, p: Profile, fn: (ctx: any, roleCalls: any[]) => Promise<T>): Promise<T> {
  const client = await api.connect();
  const roleCalls: any[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' })]);
    const profile = { centreScope: { all: p.all ?? false, centreIds: [] as string[] }, branchIds: p.branchIds ?? [], permissions: p.permissions ?? [READ, STOCK], mfaLevel: 'aal2' };
    const IdentityPort = {
      async getActor() { return profile; },
      async assertRole(_c: unknown, req: { permission: string; branchId?: string }) {
        roleCalls.push(req);
        if (!profile.permissions.includes(req.permission)) throw new LimsError('auth.forbidden');
      },
    };
    const ctx = { tenantId, actor: { type: 'user', id: SYS }, requestId: 'r1', tx: { query: (t: string, v?: unknown[]) => client.query(t, v) }, ports: { IdentityPort } };
    return await fn(ctx, roleCalls);
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
async function rej(p: Promise<unknown>): Promise<LimsError> {
  try { await p; } catch (e) { return e as LimsError; }
  throw new Error('expected a rejection, but it resolved');
}

describe.skipIf(!live)('T-04 assertStoreAccess on the real database (RLS on)', () => {
  it('visible branch + permission: resolves with the real store row; assertRole got the row\'s branch_id', async () => {
    await asActor(A, { branchIds: [BRANCH_A] }, async (ctx, roles) => {
      const s = await assertStoreAccess(ctx, uid(1001), STOCK);
      expect(s).toMatchObject({ id: uid(1001), branch_id: BRANCH_A, tenant_id: A });
      expect(roles).toEqual([{ permission: STOCK, branchId: BRANCH_A }]);
    });
  });
  it('AC-22.2 object not visible: a grant on another branch => 404 common.not_found, assertRole never called (P-B1, P-B2)', async () => {
    await asActor(A, { branchIds: [BRANCH_B] }, async (ctx, roles) => {
      const e = await rej(assertStoreAccess(ctx, uid(1001), STOCK));
      expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
      expect(roles).toEqual([]);
    });
  });
  it('P-B8 invisible AND permission missing: 404; visible AND permission missing: 403', async () => {
    await asActor(A, { branchIds: [BRANCH_B], permissions: [READ] }, async (ctx) => {
      expect((await rej(assertStoreAccess(ctx, uid(1001), STOCK))).code).toBe('common.not_found');
    });
    await asActor(A, { branchIds: [BRANCH_A], permissions: [READ] }, async (ctx) => {
      const e = await rej(assertStoreAccess(ctx, uid(1001), STOCK));
      expect([e.code, e.statusCode]).toEqual(['auth.forbidden', 403]);
    });
  });
  it('AC-22.2 action on a visible object without the permission: 403 auth.forbidden (centreScope.all)', async () => {
    await asActor(A, { all: true, permissions: [READ] }, async (ctx) => {
      expect((await rej(assertStoreAccess(ctx, uid(1002), STOCK))).code).toBe('auth.forbidden');
    });
  });
  it('centreScope.all sees every branch of the tenant (P-B4)', async () => {
    await asActor(A, { all: true }, async (ctx) => {
      await expect(assertStoreAccess(ctx, uid(1001), STOCK)).resolves.toMatchObject({ id: uid(1001) });
      await expect(assertStoreAccess(ctx, uid(1002), STOCK)).resolves.toMatchObject({ id: uid(1002) });
    });
  });
  it('AC-22.1 / P-T1 tenant isolation: A\'s store with B claims and B\'s store with A claims are 404 (RLS), whatever the actor scope', async () => {
    await asActor(B, { all: true }, async (ctx) => {
      expect((await rej(assertStoreAccess(ctx, uid(1001), STOCK))).code).toBe('common.not_found');
    });
    await asActor(A, { all: true }, async (ctx, roles) => {
      expect((await rej(assertStoreAccess(ctx, uid(1101), STOCK))).code).toBe('common.not_found');
      expect(roles).toEqual([]);
    });
    await asActor(A, { branchIds: [BRANCH_B] }, async (ctx) => { // a grant naming B's branch does not reach B's store either
      expect((await rej(assertStoreAccess(ctx, uid(1101), STOCK))).code).toBe('common.not_found');
    });
  });
  it('the 404 is identical for unknown, invisible and foreign ids (no oracle)', async () => {
    const shapes: unknown[] = [];
    for (const [t, p, id] of [[A, { all: true }, uid(999999)], [A, { branchIds: [BRANCH_B] }, uid(1001)], [A, { all: true }, uid(1101)]] as [string, Profile, string][]) {
      await asActor(t, p, async (ctx) => { const e = await rej(assertStoreAccess(ctx, id, STOCK)); shapes.push([e.code, e.statusCode, e.detail, e.errors, e.message]); });
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
  it('hostile id text is bound, not interpolated: 404 and the table survives', async () => {
    await asActor(A, { all: true }, async (ctx) => {
      expect((await rej(assertStoreAccess(ctx, "'; DROP TABLE inventory.stores; --", STOCK))).code).toMatch(/^common\.(not_found|validation_failed)$/);
    });
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM inventory.stores WHERE id = $1", [uid(1001)]);
    expect(rows[0].n).toBe(1);
  });
});

describe.skipIf(!live)('T-04 assertTransferAccess on the real database', () => {
  it('visible via the from/to branch (here both a101): read, from-action and to-action resolve', async () => {
    await asActor(A, { branchIds: [BRANCH_A] }, async (ctx) => {
      await expect(assertTransferAccess(ctx, uid(8701), { permission: READ })).resolves.toMatchObject({ id: uid(8701), from_store_id: uid(1001), to_store_id: uid(1002) });
      await expect(assertTransferAccess(ctx, uid(8701), { permission: STOCK, end: 'from' })).resolves.toMatchObject({ id: uid(8701) });
      await expect(assertTransferAccess(ctx, uid(8701), { permission: STOCK, end: 'to' })).resolves.toMatchObject({ id: uid(8701) });
    });
  });
  it('neither end visible: 404 even with the permission missing (P-B8)', async () => {
    await asActor(A, { branchIds: [BRANCH_B], permissions: [READ] }, async (ctx, roles) => {
      for (const o of [{ permission: READ }, { permission: STOCK, end: 'from' as const }, { permission: STOCK, end: 'to' as const }]) {
        expect((await rej(assertTransferAccess(ctx, uid(8701), o))).code).toBe('common.not_found');
      }
      expect(roles).toEqual([]);
    });
  });
  it('visible with the permission missing: 403', async () => {
    await asActor(A, { branchIds: [BRANCH_A], permissions: [READ] }, async (ctx) => {
      expect((await rej(assertTransferAccess(ctx, uid(8701), { permission: STOCK, end: 'from' }))).code).toBe('auth.forbidden');
    });
  });
  it('tenant isolation: B\'s transfer from tenant A (and A\'s from tenant B) is 404', async () => {
    await asActor(A, { all: true }, async (ctx) => { expect((await rej(assertTransferAccess(ctx, uid(8801), { permission: READ }))).code).toBe('common.not_found'); });
    await asActor(B, { all: true }, async (ctx) => { expect((await rej(assertTransferAccess(ctx, uid(8701), { permission: READ }))).code).toBe('common.not_found'); });
  });
});

describe.skipIf(!live)('T-04 listVisibleBranchIds with the real actor shape', () => {
  it('maps centreScope.all / branchIds the same way as in the unit tests', async () => {
    await asActor(A, { all: true }, async (ctx) => { expect((await listVisibleBranchIds(ctx)).all).toBe(true); });
    await asActor(A, { branchIds: [BRANCH_A] }, async (ctx) => {
      const v = await listVisibleBranchIds(ctx);
      expect([v.all, [...v.branchIds]]).toEqual([false, [BRANCH_A]]);
    });
  });
});
