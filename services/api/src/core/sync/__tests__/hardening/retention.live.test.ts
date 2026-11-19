// T0B-SYNC-5 done_when (3) RETENTION: a job removes confirmed operations and resolved conflicts older than the retention setting (default 180 days) in small batches without locking tables,
// never touching open conflicts or pending print markers; audit events are never removed by it. Live PG17 (throwaway container), run as lims_worker with system claims of the tenant
// (the role the worker job runs as; LIMS_TEST_WORKER_URL is exported by tests/core/T0B-SYNC-5.pg.sh). Fixtures are written owner side; the purge is the production function.
// PINNED SURFACE and rules: see the header of ./kit.ts (purgeSyncLedger in services/api/src/core/sync/retention.ts). Fails today: that module does not exist.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A1, B1, TENANT_A, TENANT_B, USER, devicePush, ensureS5, iso, newDevice, ownerRows, superTx, syncEngine, uid, okBody, withCtx } from './kit.js';

const T = 600_000;
const NOWD = new Date('2026-11-18T00:00:00Z');
const day = (n: number): Date => new Date(NOWD.getTime() - n * 86_400_000);
const OLD = day(200); const FRESH = day(10);
const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
const workerPool = new pg.Pool({ connectionString: process.env.LIMS_TEST_WORKER_URL ?? (() => { throw new Error('LIMS_TEST_WORKER_URL is not set: run .orchestra\\notes\\T0B-SYNC-5-verify.cmd'); })(), max: 6 });
workerPool.on('error', () => {});
afterAll(async () => { await workerPool.end().catch(() => {}); }, 60_000);
const SEED_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const retention = async (): Promise<any> => import('../../retention.js').catch(() => ({}));
beforeAll(ensureS5);

/** Owner side reset of this file's fixtures (everything of the tenants older than 2026-11-14; rows of the other test files are dated 2026-11-17). Children first. */
async function reset(): Promise<void> {
  for (const t of [TENANT_A, TENANT_B]) {
    await superTx(async (tx) => {
      const old = `SELECT op_id FROM core.sync_operation WHERE tenant_id = $1 AND server_received_at < '2026-11-14'`;
      await tx.query(`DELETE FROM core.sync_alert WHERE tenant_id = $1 AND op_id IN (${old})`, [t]);
      await tx.query(`DELETE FROM core.sync_signoff_outcome WHERE tenant_id = $1 AND op_id IN (${old})`, [t]);
      await tx.query(`DELETE FROM core.sync_print_marker WHERE tenant_id = $1 AND op_id IN (${old})`, [t]);
      await tx.query(`DELETE FROM core.sync_conflict WHERE tenant_id = $1 AND op_id IN (${old})`, [t]);
      await tx.query(`DELETE FROM core.sync_operation WHERE tenant_id = $1 AND server_received_at < '2026-11-14'`, [t]);
    }, t);
  }
}
beforeEach(reset);

interface SeedOp { tenant?: string; device: string; user?: string; status?: string; at: Date; type?: string; errorCode?: string }
async function seedOp(o: SeedOp): Promise<string> {
  const tenant = o.tenant ?? TENANT_A; const opId = uid();
  const status = o.status ?? 'accepted';
  await superTx((tx) => tx.query(
    `INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, server_received_at, status, result, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $7, $8, $9::jsonb, $10)`,
    [tenant, opId, o.device, o.user ?? USER.a1, o.type ?? 'result.enter', `h${opId}`, o.at.toISOString(), status, JSON.stringify({ status }), o.errorCode ?? null]), tenant);
  return opId;
}
async function seedConflict(o: { tenant?: string; opId: string; resolvedAt?: Date; createdAt?: Date }): Promise<string> {
  const tenant = o.tenant ?? TENANT_A; const id = uid();
  const resolved = o.resolvedAt !== undefined;
  await superTx((tx) => tx.query(
    `INSERT INTO core.sync_conflict (id, tenant_id, op_id, entity_type, entity_id, local_payload, server_payload, status, resolution, resolved_by, resolved_at, reason, created_at, created_by, updated_by)
     VALUES ($1, $2, $3, 'order', $4, '{}'::jsonb, '{}'::jsonb, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [id, tenant, o.opId, uid(), resolved ? 'resolved' : 'open', resolved ? 'keep_server' : null, resolved ? (tenant === TENANT_A ? USER.a1 : USER.b1) : null, o.resolvedAt?.toISOString() ?? null,
      resolved ? 'resolved (synthetic)' : null, (o.createdAt ?? OLD).toISOString(), tenant === TENANT_A ? USER.a1 : USER.b1]), tenant);
  return id;
}
const seedMarker = (opId: string, state: string, device: string) => superTx((tx) => tx.query(
  `INSERT INTO core.sync_print_marker (tenant_id, op_id, report_version_id, result_ids, device_id, state, device_created_at) VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7)`,
  [TENANT_A, opId, uid(), [uid()], device, state, OLD.toISOString()]));
const seedSignoff = (opId: string, device: string) => superTx((tx) => tx.query(
  `INSERT INTO core.sync_signoff_outcome (tenant_id, op_id, device_id, result_id, outcome, device_created_at) VALUES ($1, $2, $3, $4, 'accepted', $5)`, [TENANT_A, opId, device, uid(), OLD.toISOString()]));
const seedAlert = (opId: string) => superTx((tx) => tx.query(`INSERT INTO core.sync_alert (id, tenant_id, kind, op_id, code) VALUES ($1, $2, 'result_locked', $3, 'sync.result_locked')`, [uid(), TENANT_A, opId]));
const present = async (table: string, col: string, ids: string[]): Promise<string[]> =>
  (await ownerRows(`SELECT ${col}::text AS k FROM core.${table} WHERE ${col} = ANY($1::uuid[])`, [ids])).map((r) => r.k).sort();
const opsLeft = (ids: string[]) => present('sync_operation', 'op_id', ids);
const same = (xs: string[]): string[] => [...xs].sort();

/** A db like the worker's deps.db.tx: one transaction per call as lims_worker, system claims of the tenant. `hook` runs after every statement while the transaction is still open. */
function workerDb(tenant: string, hook?: (statement: string, rowCount: number, pid: number) => Promise<void>) {
  const txs: Array<{ n: number; opsRemoved: number; conflictsRemoved: number }> = []; const statements: string[] = [];
  const count = async (table: string): Promise<number> => Number((await ownerRows(`SELECT count(*)::int AS n FROM core.${table} WHERE tenant_id = $1`, [tenant]))[0].n);
  return {
    txs, statements,
    db: {
      async tx<R>(fn: (tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }) => Promise<R>): Promise<R> {
        const before = { o: await count('sync_operation'), c: await count('sync_conflict') };
        const c = await workerPool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SEED_ACTOR, actor_type: 'system' })]);
          await c.query("SELECT set_config('app.request_id', $1, true)", [uid()]);
          const out = await fn({ query: async (t, v) => { const r = await c.query(t, v); statements.push(t); if (hook) await hook(t, r.rowCount ?? 0, c.processID); return r; } });
          await c.query('COMMIT');
          txs.push({ n: txs.length + 1, opsRemoved: before.o - (await count('sync_operation')), conflictsRemoved: before.c - (await count('sync_conflict')) });
          return out;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
    },
  };
}
const sink = () => { const calls: Array<{ name: string; labels: any; by: number }> = []; return { calls, inc: (name: string, labels?: any, by = 1) => { calls.push({ name, labels, by }); } }; };
async function purge(o: Record<string, unknown> = {}, tenant = TENANT_A, w = workerDb(tenant)) {
  const { purgeSyncLedger } = await retention();
  expect(typeof purgeSyncLedger, 'services/api/src/core/sync/retention.ts must export purgeSyncLedger').toBe('function');
  const result = await purgeSyncLedger(w.db, { tenantId: tenant, now: NOWD, ...o });
  return { result, w };
}

describe('what is removed (default 180 days)', () => {
  it('the default retention is 180 days', async () => {
    expect((await retention()).DEFAULT_SYNC_RETENTION_DAYS).toBe(180);
  });

  it('confirmed operations (accepted, duplicate, rejected) older than 180 days are removed; fresh ones stay; the boundary is strict', async () => {
    const dev = await newDevice(A1);
    const cutoff = day(180);
    const old = await Promise.all(['accepted', 'duplicate', 'rejected'].map((s) => seedOp({ device: dev, status: s, at: OLD, errorCode: s === 'rejected' ? 'sync.result_locked' : undefined })));
    const fresh = await Promise.all([seedOp({ device: dev, at: FRESH }), seedOp({ device: dev, at: day(179) })]);
    const atCutoff = await seedOp({ device: dev, at: cutoff });                              // exactly 180 days: kept (strict <)
    const justOver = await seedOp({ device: dev, at: new Date(cutoff.getTime() - 1) });      // 1 ms older: removed
    const { result } = await purge();
    expect(result.operations).toBe(4);
    expect(await opsLeft([...old, ...fresh, atCutoff, justOver])).toEqual(same([...fresh, atCutoff]));
  }, T);

  it('a resolved conflict older than the retention is removed with its (conflict status) operation; a conflict resolved recently is kept with its operation', async () => {
    const dev = await newDevice(A1);
    const opOld = await seedOp({ device: dev, status: 'conflict', at: OLD }); const cOld = await seedConflict({ opId: opOld, resolvedAt: day(190) });
    const opRecent = await seedOp({ device: dev, status: 'conflict', at: OLD }); const cRecent = await seedConflict({ opId: opRecent, resolvedAt: FRESH });
    const { result } = await purge();
    expect(result.conflicts).toBe(1); expect(result.operations).toBe(1);
    expect(await present('sync_conflict', 'id', [cOld, cRecent])).toEqual([cRecent]);
    expect(await opsLeft([opOld, opRecent])).toEqual([opRecent]);
  }, T);

  it('an OPEN conflict is never touched, however old, and neither is its operation', async () => {
    const dev = await newDevice(A1);
    const op = await seedOp({ device: dev, status: 'conflict', at: day(400) }); const c = await seedConflict({ opId: op, createdAt: day(400) });
    const other = await seedOp({ device: dev, at: OLD });
    const { result } = await purge();
    expect(result.operations).toBe(1);
    expect(await present('sync_conflict', 'id', [c])).toEqual([c]);
    expect(await opsLeft([op, other])).toEqual([op]);
    expect((await ownerRows('SELECT status FROM core.sync_conflict WHERE id = $1', [c]))[0].status).toBe('open');
  }, T);

  it('print markers: a PENDING marker (and its operation) is never touched; a recall_required one is kept as recall evidence; a confirmed one goes with its operation', async () => {
    const dev = await newDevice(A1);
    const mk = async (state: string) => { const id = await seedOp({ device: dev, type: 'report.print_marker', at: OLD }); await seedMarker(id, state, dev); return id; };
    const [pending, recall, confirmed] = [await mk('pending'), await mk('recall_required'), await mk('confirmed')];
    const { result } = await purge();
    expect(result.operations).toBe(1);
    expect(await opsLeft([pending, recall, confirmed])).toEqual(same([pending, recall]));
    expect(await present('sync_print_marker', 'op_id', [pending, recall, confirmed])).toEqual(same([pending, recall]));
    expect((await ownerRows(`SELECT state FROM core.sync_print_marker WHERE op_id = $1`, [pending]))[0].state).toBe('pending');
  }, T);

  it('the sign off outcomes and lab manager alerts of a removed operation go with it; those of a kept operation stay', async () => {
    const dev = await newDevice(A1);
    const gone = await seedOp({ device: dev, type: 'result.verify', at: OLD }); await seedSignoff(gone, dev); await seedAlert(gone);
    const kept = await seedOp({ device: dev, type: 'result.verify', at: FRESH }); await seedSignoff(kept, dev); await seedAlert(kept);
    await purge();
    expect(await opsLeft([gone, kept])).toEqual([kept]);
    expect(await present('sync_signoff_outcome', 'op_id', [gone, kept])).toEqual([kept]);
    expect((await ownerRows('SELECT op_id::text FROM core.sync_alert WHERE op_id = ANY($1::uuid[])', [[gone, kept]])).map((r) => r.op_id)).toEqual([kept]);
  }, T);

  it('the retention setting is honoured (30 days removes 60 day old rows, keeps 10 day old ones) and is validated BEFORE any delete (0, negative, fraction, NaN, string)', async () => {
    const dev = await newDevice(A1);
    const sixty = await seedOp({ device: dev, at: day(60) }); const ten = await seedOp({ device: dev, at: FRESH });
    for (const bad of [0, -1, 1.5, Number.NaN, '180']) {
      const { purgeSyncLedger } = await retention();
      await expect(purgeSyncLedger(workerDb(TENANT_A).db, { tenantId: TENANT_A, now: NOWD, retentionDays: bad })).rejects.toBeTruthy();
    }
    expect(await opsLeft([sixty, ten])).toEqual(same([sixty, ten]));
    const { result } = await purge({ retentionDays: 30 });
    expect(result.operations).toBe(1);
    expect(await opsLeft([sixty, ten])).toEqual([ten]);
  }, T);

  it('only the given tenant: another tenant\'s old rows survive (RLS and an explicit tenant filter); the second tenant is purged by its own run', async () => {
    const devA = await newDevice(A1); const devB = await newDevice(B1);
    const a = await seedOp({ device: devA, at: OLD });
    const b = await seedOp({ tenant: TENANT_B, device: devB, user: USER.b1, at: OLD });
    await purge();
    expect(await opsLeft([a, b])).toEqual([b]);
    await purge({}, TENANT_B);
    expect(await opsLeft([a, b])).toEqual([]);
  }, T);

  it('a run is idempotent: the second run removes nothing and does not fail', async () => {
    const dev = await newDevice(A1);
    await seedOp({ device: dev, at: OLD });
    expect((await purge()).result.operations).toBe(1);
    expect((await purge()).result).toMatchObject({ operations: 0, conflicts: 0, capped: false });
  }, T);
});

describe('small batches, no table locks, no lost concurrency', () => {
  async function seedMany(n: number): Promise<string[]> {
    const dev = await newDevice(A1);
    await superTx((tx) => tx.query(
      `INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, server_received_at, status, result)
       SELECT $1, gen_random_uuid(), $2, $3, 'result.enter', 'h' || g, '{}'::jsonb, $4, $4, 'accepted', '{"status":"accepted"}'::jsonb FROM generate_series(1, $5) g`,
      [TENANT_A, dev, USER.a1, OLD.toISOString(), n]));
    return (await ownerRows(`SELECT op_id::text FROM core.sync_operation WHERE tenant_id = $1 AND server_received_at < '2026-11-14'`, [TENANT_A])).map((r) => r.op_id);
  }

  it('1 250 old operations with batchSize 100: every batch is its own transaction (own commit) and removes at most 100 operations; all are gone in the end', async () => {
    const ids = await seedMany(1250);
    const w = workerDb(TENANT_A); const m = sink();
    const { result } = await purge({ batchSize: 100, metrics: m }, TENANT_A, w);
    expect(result).toMatchObject({ operations: 1250, conflicts: 0, capped: false });
    expect(result.batches).toBeGreaterThanOrEqual(13);
    const working = w.txs.filter((t) => t.opsRemoved > 0);
    expect(working.length).toBeGreaterThanOrEqual(13);
    for (const t of w.txs) { expect(t.opsRemoved).toBeLessThanOrEqual(100); expect(t.conflictsRemoved).toBeLessThanOrEqual(100); }
    expect(w.txs.reduce((s, t) => s + t.opsRemoved, 0)).toBe(1250);
    expect(await opsLeft(ids)).toEqual([]);
    expect(m.calls.filter((c) => c.name === 'lims_core_retention_purged_total' && c.labels?.table === 'sync_operation').reduce((s, c) => s + c.by, 0)).toBe(1250);
  }, T);

  it('maxBatches caps one run (capped = true, the cap metric moves); the next run continues; nothing is lost or removed twice', async () => {
    const ids = await seedMany(500);
    const m = sink();
    const first = (await purge({ batchSize: 100, maxBatches: 2, metrics: m })).result;
    expect(first.capped).toBe(true); expect(first.operations).toBe(200); expect(first.batches).toBeLessThanOrEqual(2);
    expect(m.calls.some((c) => c.name === 'lims_core_retention_purge_capped_total' && c.labels?.table === 'sync_operation')).toBe(true);
    expect((await opsLeft(ids)).length).toBe(300);
    const second = (await purge({ batchSize: 100 })).result;
    expect(second.operations).toBe(300); expect(second.capped).toBe(false);
  }, T);

  it('while a batch is open (rows locked) the job holds NO table level lock on the sync tables and a concurrent push of the same tenant is not blocked', async () => {
    const ids = await seedMany(60);
    const H = syncEngine(`S5RT-${uid().slice(-8)}`);
    const dev = await newDevice(A1);
    let checked = false; let lockModes: string[] = []; let pushed: any; let pushMs = Infinity;
    const w = workerDb(TENANT_A, async (_statement, rowCount, pid) => {
      if (checked || rowCount === 0) return;
      checked = true;
      lockModes = (await ownerRows(
        `SELECT l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE l.pid = $1 AND l.granted AND n.nspname = 'core' AND c.relname IN ('sync_operation','sync_conflict','sync_signoff_outcome','sync_alert','sync_print_marker')`, [pid])).map((r) => r.mode);
      const op = { op_id: uid(), op_type: 'result.enter', payload: { value: 1 }, device_created_at: iso(new Date('2026-11-17T08:00:00Z')) };
      const t0 = Date.now();
      pushed = await Promise.race([devicePush(H, A1, dev, [op]), new Promise((r) => setTimeout(() => r('blocked'), 15_000))]);
      pushMs = Date.now() - t0;
    });
    await purge({ batchSize: 20 }, TENANT_A, w);
    expect(checked).toBe(true);
    expect(lockModes.length).toBeGreaterThan(0);                                              // the probe saw the job's own (row level) locks
    for (const m of lockModes) expect(['AccessShareLock', 'RowShareLock', 'RowExclusiveLock']).toContain(m);
    expect(pushed).not.toBe('blocked'); expect(pushMs).toBeLessThan(15_000);
    expect(okBody(pushed).results[0].status).toBe('accepted');
    expect(await opsLeft(ids)).toEqual([]);
  }, T);

  it('two purges of the same tenant at the same moment remove every row exactly once, with no error and no deadlock', async () => {
    const ids = await seedMany(400);
    const [a, b] = await Promise.all([purge({ batchSize: 50 }), purge({ batchSize: 50 })]);
    expect(a.result.operations + b.result.operations).toBe(400);
    expect(await opsLeft(ids)).toEqual([]);
  }, T);
});

describe('audit events are never removed; the app role still cannot delete', () => {
  it('the audit log of the tenant only grows (the table triggers add rows for the removed conflicts); the job runs no statement against audit.*', async () => {
    const dev = await newDevice(A1);
    const op = await seedOp({ device: dev, status: 'conflict', at: OLD }); await seedConflict({ opId: op, resolvedAt: day(190) });
    await seedOp({ device: dev, at: OLD });
    const count = async (): Promise<{ all: number; conflict: number }> => ({
      all: Number((await ownerRows(`SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1`, [TENANT_A]))[0].n),
      conflict: Number((await ownerRows(`SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'core' AND table_name = 'sync_conflict'`, [TENANT_A]))[0].n),
    });
    const before = await count();
    const { w } = await purge();
    const after = await count();
    expect(after.all).toBeGreaterThanOrEqual(before.all);
    expect(after.conflict).toBeGreaterThanOrEqual(before.conflict);
    expect(w.statements.some((s) => /\baudit\./i.test(s))).toBe(false);
  }, T);

  it('lims_api (the request role) has no DELETE on the ledger tables: permission denied, the job is the only way a row leaves', async () => {
    for (const t of ['sync_operation', 'sync_conflict', 'sync_signoff_outcome', 'sync_print_marker', 'sync_alert']) {
      const o = await withCtx({ tenant: TENANT_A, userId: USER.a1 }, (ctx: any) => ctx.tx.query(`DELETE FROM core.${t} WHERE false`));
      expect(o.error?.code, t).toBe('42501');
    }
  }, T);
});
