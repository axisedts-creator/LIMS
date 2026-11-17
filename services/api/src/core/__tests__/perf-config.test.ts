// T0B-PERF-1 (LD-310) done_when 4: statement timeout 5 s reads / 15 s writes and a pool size that fits the Supabase pooler,
// all from env with safe defaults. Also the pool wiring in boot.ts.
// INTERFACE EXPECTED: config.writeStatementTimeoutMs <- LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS (default 15000); config.statementTimeoutMs (reads) stays
// LIMS_CORE_STATEMENT_TIMEOUT_MS (default 5000); config.dbPoolMax default <= 10; createDb({ writeStatementTimeoutMs? });
// RequestTxInput.readOnly?: boolean (the pipeline passes it from the HTTP method: GET and HEAD are reads, anything else a write).
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb } from '../db/tx.js';
import { createFakePgBouncer, recorder, txInput } from '../db/__tests__/helpers.js';
import { makeRig } from '../pipeline/__tests__/helpers.js';

const cfg = (extra: Record<string, string> = {}) => loadConfig({ LIMS_CORE_ENV: 'ci', ...extra });

describe('config defaults and validation', () => {
  it('reads 5000 ms, writes 15000 ms by default', () => {
    expect(cfg().statementTimeoutMs).toBe(5000);
    expect((cfg() as any).writeStatementTimeoutMs).toBe(15000);
  });
  it('both come from the environment', () => {
    const c = cfg({ LIMS_CORE_STATEMENT_TIMEOUT_MS: '2000', LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS: '9000' }) as any;
    expect([c.statementTimeoutMs, c.writeStatementTimeoutMs]).toEqual([2000, 9000]);
  });
  it.each(['0', '-1', 'abc', '1.5', ''])('write timeout %j is refused, naming the key', (v) => {
    expect(() => cfg({ LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS: v })).toThrow(/LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS/);
  });
  it('the pool default fits the Supabase pooler (<= 10) and is at least 2', () => {
    expect(cfg().dbPoolMax).toBeLessThanOrEqual(10);
    expect(cfg().dbPoolMax).toBeGreaterThanOrEqual(2);
  });
  it('LIMS_CORE_DB_POOL_MAX is honoured, and 0, text and an absurd size (over the pooler) are refused', () => {
    expect(cfg({ LIMS_CORE_DB_POOL_MAX: '5' }).dbPoolMax).toBe(5);
    for (const v of ['0', 'abc', '100000']) expect(() => cfg({ LIMS_CORE_DB_POOL_MAX: v }), v).toThrow(/LIMS_CORE_DB_POOL_MAX/);
  });
});

describe('the timeout applied to a transaction', () => {
  const timeoutOf = (fake: ReturnType<typeof createFakePgBouncer>) =>
    Number(fake.log.find((l) => /statement_timeout/.test(l.text))!.values[4]);

  it('createDb: readOnly true -> read timeout, readOnly false or unset -> write timeout', async () => {
    for (const [ro, want] of [[true, 5000], [false, 15000], [undefined, 15000]] as const) {
      const fake = createFakePgBouncer(1);
      const rec = recorder();
      const db = createDb({ pool: fake.pool, log: rec.log as any, metrics: rec.metrics as any, statementTimeoutMs: 5000, writeStatementTimeoutMs: 15000 } as any);
      await db.requestTx(txInput({ ...(ro === undefined ? {} : { readOnly: ro }) }) as any, async () => 1);
      expect(timeoutOf(fake), String(ro)).toBe(want);
    }
  });

  it('an explicit per call statementTimeoutMs still wins', async () => {
    const fake = createFakePgBouncer(1);
    const db = createDb({ pool: fake.pool, log: recorder().log as any, metrics: recorder().metrics as any, statementTimeoutMs: 5000, writeStatementTimeoutMs: 15000 } as any);
    await db.requestTx(txInput({ readOnly: true, statementTimeoutMs: 777 }) as any, async () => 1);
    expect(timeoutOf(fake)).toBe(777);
  });

  it('the pipeline passes the HTTP method: GET -> 5000 ms, POST -> 15000 ms (createDb defaults)', async () => {
    const rig = makeRig();
    await rig.run({ op: { module: 'frontdesk', operationId: 'listThings', method: 'GET', routeTemplate: '/v1/frontdesk/things', public: false, context: 'tenant', idempotency: 'none', rateLimitTier: 'general' } });
    expect(timeoutOf(rig.fake)).toBe(5000);
    const rig2 = makeRig();
    await rig2.run();
    expect(timeoutOf(rig2.fake)).toBe(15000);
  });
});

describe('boot.ts builds the pg pool from config', () => {
  it('max = LIMS_CORE_DB_POOL_MAX, an idle timeout and a connect timeout are set, and the pool is ended on close', async () => {
    const seen: Array<Record<string, any>> = [];
    let ended = 0;
    vi.resetModules();
    vi.doMock('pg', () => {
      class Pool {
        constructor(o: Record<string, any>) { seen.push(o); }
        on() { return this; }
        async query() { return { rows: [{ ok: true }] }; }
        async connect() { throw new Error('unused'); }
        async end() { ended += 1; }
      }
      return { default: { Pool }, Pool };
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'perf-key-'));
      const keyFile = join(dir, 'rl.key');
      writeFileSync(keyFile, 'synthetic-ratelimit-key-for-tests');
      const { bootPipeline } = await import('../pipeline/boot.js');
      const { loadConfig: lc } = await import('../config.js');
      const { createMetrics } = await import('../observability/metrics.js');
      const log = { info() {}, warn() {}, error() {} };
      const config = lc({ LIMS_CORE_ENV: 'ci', LIMS_CORE_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', LIMS_CORE_RATELIMIT_KEY_FILE: keyFile, LIMS_CORE_DB_POOL_MAX: '6' });
      const boot = await bootPipeline({ config, modules: [], log: log as any, metrics: createMetrics() });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.max).toBe(6);
      expect(seen[0]!.idleTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(seen[0]!.idleTimeoutMillis).toBeLessThanOrEqual(60000);
      expect(seen[0]!.connectionTimeoutMillis).toBeLessThanOrEqual(10000);
      await boot.close();
      expect(ended).toBe(1);
    } finally {
      vi.doUnmock('pg');
      vi.resetModules();
    }
  });
});
