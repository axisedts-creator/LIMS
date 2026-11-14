// C10 T-13 — the same lifecycle invariants as breakpoint.lifecycle.test.ts, against REAL PostgreSQL (two parallel transactions on two connections) + the AC-13.4 grant test.
// Needs the micro DDL + RLS of 05-SCHEMA §8/§4 applied: LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser (as T-05).
// Without them the DB tests skip, except under LIMS_T13_REQUIRE_DB=1 where "database is provided" fails. Only rows created here (own random ids) are written and deleted.
// SEAMS: as breakpoint.lifecycle.test.ts (If-Match "<version>", settings row locked FOR UPDATE, previous active closed in the same transaction).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T13_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const IMPORTER = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const ACTIVATOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b6';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const MANAGE = 'micro.breakpoint.manage';
const claims = JSON.stringify({ tenant_id: A, sub: ACTIVATOR, actor_type: 'user' });
const DAY = 86_400_000;

let api: pg.Pool;
let admin: pg.Pool;
const mine: string[] = [];

async function call(op: string, setId: string, version: number, body: object = {}): Promise<{ status: number; body: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    const ctx: any = {
      operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: A, tx: client, requestId: randomUUID(), now: () => new Date(),
      actor: { type: 'user', id: ACTIVATOR, membershipId: MEM },
      ports: { IdentityPort: { async assertRole(_c: unknown, x: { permission: string }) { if (x.permission !== MANAGE && x.permission !== 'micro.culture.read') throw new LimsError('auth.forbidden'); } } },
      core: { user: async () => ({ displayName: 'Synthetic User' }) },
      audit: { access: async () => undefined }, events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
    };
    const out: any = await (handlers as any)[op]({ params: { set_id: setId }, query: {}, headers: { 'if-match': `"${version}"`, 'idempotency-key': `t13-${randomUUID()}` }, body }, ctx);
    await client.query('COMMIT');
    return { status: out.status, body: out.body };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}

async function seedSet(status: 'validated' | 'active'): Promise<string> {
  const id = randomUUID();
  mine.push(id);
  await admin.query(
    `INSERT INTO micro.breakpoint_sets (id, tenant_id, standard, standard_version, title, licence_attestation_text, file_bucket, file_object_path, file_sha256, file_bytes, status,
       effective_from, activated_by, activated_at, created_by, updated_by, version)
     VALUES ($1, $2, 'CLSI', 'syn', 'Synthetic', 'Synthetic attestation: seeded test row only.', 'micro-imports', $3, $4, 10, $5, $6, $7, $8, $9, $9, $10)`,
    [id, A, `${A}/breakpoints/${id}.csv`, (randomUUID() + randomUUID()).replaceAll('-', '').slice(0, 64), status,
      status === 'active' ? new Date(Date.now() - 10 * DAY) : null, status === 'active' ? ACTIVATOR : null, status === 'active' ? new Date(Date.now() - 10 * DAY) : null, IMPORTER, status === 'active' ? 2 : 1],
  );
  return id;
}
const sets = async (ids: string[]) => (await admin.query('SELECT id, status, effective_from, effective_to FROM micro.breakpoint_sets WHERE id = ANY($1::uuid[])', [ids])).rows as Record<string, any>[];

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('LIMS_T13_REQUIRE_DB=1 but LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL are not set'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 6 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
});
afterAll(async () => {
  if (!live) return;
  if (mine.length) await admin.query('DELETE FROM micro.breakpoint_sets WHERE id = ANY($1::uuid[])', [mine]).catch(() => undefined);
  await api.end(); await admin.end();
});

describe.skipIf(!live && !REQUIRE)('C10-T13 real PostgreSQL: two parallel activations (done_when)', () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))('round %i: two validated CLSI sets activated in parallel => both 200, exactly one active, the rest retired, no overlap', async () => {
    const prev = await seedSet('active');
    const n1 = await seedSet('validated'); const n2 = await seedSet('validated');
    const res = await Promise.allSettled([call('activateBreakpointSet', n1, 1), call('activateBreakpointSet', n2, 1)]);
    expect(res.map((r) => r.status), JSON.stringify(res.map((r) => (r as any).reason?.message))).toEqual(['fulfilled', 'fulfilled']);
    const rows = await sets([prev, n1, n2]);
    expect(rows.filter((r) => r['status'] === 'active')).toHaveLength(1);
    expect(rows.filter((r) => r['status'] === 'retired')).toHaveLength(2);
    const per = rows.map((r) => ({ id: r['id'], from: new Date(r['effective_from']).getTime(), to: r['effective_to'] == null ? Infinity : new Date(r['effective_to']).getTime() }));
    for (const a of per) for (const b of per) if (a !== b) expect(a.from < b.to && b.from < a.to, `overlap ${a.id} / ${b.id}`).toBe(false);
    // clean up the active one so the next round starts without a live set of ours (the partial unique index is on the file hash only, but keep the tenant tidy)
    await admin.query('DELETE FROM micro.breakpoint_sets WHERE id = ANY($1::uuid[])', [[prev, n1, n2]]);
  });
  it('double submit of the same activation => exactly one succeeds, the other is a 409', async () => {
    const prev = await seedSet('active'); const next = await seedSet('validated');
    const res = await Promise.allSettled([call('activateBreakpointSet', next, 1), call('activateBreakpointSet', next, 1)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason.statusCode).toBe(409);
    expect((await sets([prev, next])).map((r) => r['status']).sort()).toEqual(['active', 'retired']);
    await admin.query('DELETE FROM micro.breakpoint_sets WHERE id = ANY($1::uuid[])', [[prev, next]]);
  });
  it('the importer cannot activate: 403 micro.breakpoint_four_eyes_required and the set stays validated', async () => {
    const next = await seedSet('validated');
    const client = await api.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: IMPORTER, actor_type: 'user' })]);
      const ctx: any = { operationId: 'activateBreakpointSet', tenantId: A, tx: client, requestId: randomUUID(), now: () => new Date(), log: { info() {}, warn() {}, error() {} },
        actor: { type: 'user', id: IMPORTER, membershipId: MEM }, ports: { IdentityPort: { async assertRole() {} } }, core: { user: async () => ({ displayName: 'x' }) }, audit: { access: async () => undefined } };
      const e = await (handlers as any)['activateBreakpointSet']({ params: { set_id: next }, query: {}, headers: { 'if-match': '"1"' }, body: {} }, ctx).then(() => undefined, (x: any) => x);
      expect(e?.code).toBe('micro.breakpoint_four_eyes_required');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect((await sets([next]))[0]!['status']).toBe('validated');
    await admin.query('DELETE FROM micro.breakpoint_sets WHERE id = $1', [next]);
  });
});

describe.skipIf(!live && !REQUIRE)('C10-T13 AC-13.4 grants: rows and bands of a set are never updated or deleted', () => {
  it.each(['breakpoint_rows', 'breakpoint_bands'])('the application role has no UPDATE and no DELETE on micro.%s, and a real UPDATE / DELETE is refused (42501)', async (table) => {
    const priv = async (p: string) => (await api.query('SELECT has_table_privilege(current_user, $1, $2) AS ok', [`micro.${table}`, p])).rows[0].ok;
    expect(await priv('UPDATE')).toBe(false);
    expect(await priv('DELETE')).toBe(false);
    const client = await api.connect();
    try {
      for (const sql of [`UPDATE micro.${table} SET created_by = created_by WHERE false`, `DELETE FROM micro.${table} WHERE false`]) {
        await client.query('BEGIN');
        const e: any = await client.query(sql).then(() => undefined, (x) => x);
        await client.query('ROLLBACK');
        expect(e?.code, sql).toBe('42501');
      }
    } finally { client.release(); }
  });
  it('breakpoint_sets cannot be deleted by the application role either', async () => {
    expect((await api.query("SELECT has_table_privilege(current_user, 'micro.breakpoint_sets', 'DELETE') AS ok")).rows[0].ok).toBe(false);
  });
});
