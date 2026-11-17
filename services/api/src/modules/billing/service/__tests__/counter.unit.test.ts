// BL-T04 service/counter.service.ts — unit tests over a fake tx (02-TRD §12 steps 0–3; US-BL-01.3/.4/.5; 07-SECURITY counter row).
// Assumed API (spec gives only `allocate(tx, {series, fiscalYearBs})`; writer: object via dispute if wrong):
//   createCounterService(deps?: { config?: { counterLockTimeoutMs: number } })      // default = loadBillingConfig().counterLockTimeoutMs (3000)
//   .allocate(tx, { tenantId, series, fiscalYearBs, actorId, invoiceNoPattern?, timezone? }) -> Promise<{ lastNo: number; allocatedAt: IsoUtc }>
//   series 'INV:<branch>' = branch scope: `invoiceNoPattern` is then REQUIRED and must contain {branch} (missing = fail closed).
//   allocated_at comes from the UPDATE … RETURNING last_no, clock_timestamp() AS allocated_at row (Date or ISO string) — the "injected clock" is that row.
//   If the repository's bumpCounter cannot return allocated_at, the service issues its own UPDATE (it is "the ONLY code that touches fiscal_counters").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCounterService } from '../counter.service.js';
import { ACTOR, INS, LOCK, TENANT, UPD, fakeTx, healthy, lockValue, pgError } from './helpers.js';

const svc = createCounterService();
const base = { tenantId: TENANT, series: 'INV', fiscalYearBs: '2082/83', actorId: ACTOR };
const NEW_FY = '2025-07-16T18:15:00.000Z'; // Shrawan 1 2082 00:00 Asia/Kathmandu (01 §4.8)
const LAST_MS = '2025-07-16T18:14:59.999Z'; // one ms earlier = still 2081/82
const MID = '2026-01-05T06:00:00.000Z'; // Poush 2082 → 2082/83

describe('allocate — happy path (TRD §12 steps 1, 2, 2a, 4)', () => {
  it('returns last_no and allocated_at (ISO UTC) from the UPDATE … RETURNING row', async () => {
    const { tx } = fakeTx(healthy(41, MID));
    await expect(svc.allocate(tx, base)).resolves.toEqual({ lastNo: 42, allocatedAt: MID });
  });
  it('accepts allocated_at as a Date (the pg driver parses timestamptz) and returns ISO text', async () => {
    const { tx } = fakeTx(healthy(0, new Date(MID)));
    await expect(svc.allocate(tx, base)).resolves.toEqual({ lastNo: 1, allocatedAt: MID });
  });
  it('order: set lock_timeout → one UPDATE … RETURNING → reset lock_timeout to 0 (same tx, transaction-local)', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await svc.allocate(tx, base);
    const set = calls.findIndex((c) => LOCK.test(c.sql)), upd = calls.findIndex((c) => UPD.test(c.sql));
    const reset = calls.findIndex((c, i) => i > upd && LOCK.test(c.sql));
    expect(set).toBeGreaterThanOrEqual(0); expect(upd).toBeGreaterThan(set); expect(reset).toBeGreaterThan(upd);
    expect(lockValue(calls[set]!)).toBe('3000ms'); // LIMS_BILLING_COUNTER_LOCK_TIMEOUT_MS default
    expect(lockValue(calls[reset]!)).toMatch(/^0(ms)?$/);
    expect(calls[set]!.sql + calls[reset]!.sql).toMatch(/set_config/i);
    expect(JSON.stringify(calls[set]!)).not.toMatch(/false|SET LOCAL/i); // is_local must be true: `SET` / false would leak to a pooled connection
    expect(/,\s*(true|\$\d+)\s*\)/i.test(calls[set]!.sql)).toBe(true);
    expect(calls.slice(upd + 1, reset)).toEqual([]); // nothing between the UPDATE and the reset
    expect(calls.filter((c) => UPD.test(c.sql))).toHaveLength(1);
  });
  it('the UPDATE is a bound, tenant/series/fy-scoped, open-row increment that returns clock_timestamp()', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await svc.allocate(tx, { ...base, series: 'INV' });
    const u = calls.find((c) => UPD.test(c.sql))!;
    expect(u.sql).toMatch(/last_no\s*=\s*last_no\s*\+\s*1/i);
    expect(u.sql).toMatch(/closed_at\s+IS\s+NULL/i);
    expect(u.sql).toMatch(/RETURNING[^;]*last_no/i);
    expect(u.sql).toMatch(/clock_timestamp\(\)/i);
    expect(u.values).toEqual(expect.arrayContaining([TENANT, 'INV', '2082/83', ACTOR]));
    for (const c of calls) for (const lit of [TENANT, '2082/83', ACTOR]) expect(c.sql).not.toContain(lit); // values are bound, never inlined
  });
  it('the configured lock timeout is used (LIMS_BILLING_COUNTER_LOCK_TIMEOUT_MS)', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await createCounterService({ config: { counterLockTimeoutMs: 1500 } }).allocate(tx, base);
    expect(lockValue(calls.find((c) => LOCK.test(c.sql))!)).toBe('1500ms');
  });
  it.each(['CN', 'RC', 'INV:KTM'])('series %s is allocatable (INV:<branch> with a {branch} pattern)', async (series) => {
    const { tx } = fakeTx(healthy(6, MID));
    await expect(svc.allocate(tx, { ...base, series, invoiceNoPattern: '{branch}-{fy}-{seq:6}' })).resolves.toMatchObject({ lastNo: 7 });
  });
});

describe('lock timeout (US-BL-01.4; TRD §12 step 2)', () => {
  it('55P03 raised by the counter UPDATE → billing.counter_busy, 503, Retry-After 1, no detail', async () => {
    const { tx } = fakeTx((c) => { if (UPD.test(c.sql)) throw pgError('55P03', 'canceling statement due to lock timeout'); return undefined; });
    const e: any = await svc.allocate(tx, base).catch((x) => x);
    expect(e).toMatchObject({ code: 'billing.counter_busy', statusCode: 503, retryAfterSeconds: 1 });
    expect(e.detail).toBeUndefined();
  });
  it('55P03 from any OTHER statement is not mis-mapped (review C4 #29)', async () => {
    const { tx } = fakeTx((c) => { if (LOCK.test(c.sql)) throw pgError('55P03'); return undefined; });
    await expect(svc.allocate(tx, base)).rejects.toMatchObject({ code: '55P03' });
  });
  it('40P01 deadlock propagates raw so the owner of the transaction can retry it', async () => {
    const { tx } = fakeTx((c) => { if (UPD.test(c.sql)) throw pgError('40P01'); return undefined; });
    await expect(svc.allocate(tx, base)).rejects.toMatchObject({ code: '40P01' });
  });
  it('the service never retries on its own (billing does not retry a transaction it does not own, D-25)', async () => {
    const { tx, calls } = fakeTx((c) => { if (UPD.test(c.sql)) throw pgError('55P03'); return undefined; });
    await svc.allocate(tx, base).catch(() => undefined);
    expect(calls.filter((c) => UPD.test(c.sql))).toHaveLength(1);
  });
});

describe('fiscal-year rollover (US-BL-01.3; D-25; injected clock at Shrawan 1)', () => {
  it('counter row FY 2081/82 but allocated_at = Shrawan 1 00:00:00.000 NPT → counter_busy detail fiscal_year_rollover (503)', async () => {
    const { tx } = fakeTx(healthy(9, NEW_FY));
    await expect(svc.allocate(tx, { ...base, fiscalYearBs: '2081/82' })).rejects.toMatchObject({
      code: 'billing.counter_busy', detail: 'fiscal_year_rollover', statusCode: 503,
    });
  });
  it('one millisecond earlier the old FY is still current → allocation succeeds', async () => {
    const { tx } = fakeTx(healthy(9, LAST_MS));
    await expect(svc.allocate(tx, { ...base, fiscalYearBs: '2081/82' })).resolves.toMatchObject({ lastNo: 10, allocatedAt: LAST_MS });
  });
  it('first allocation of the new FY at Shrawan 1 gets invoice_seq = 1 (row created at 0, then bumped)', async () => {
    let n = 0;
    const { tx, calls } = fakeTx((c) => (UPD.test(c.sql) ? (++n === 1 ? { rows: [] } : { rows: [{ last_no: 1, allocated_at: NEW_FY }] }) : undefined));
    await expect(svc.allocate(tx, base)).resolves.toEqual({ lastNo: 1, allocatedAt: NEW_FY });
    expect(calls.filter((c) => INS.test(c.sql))).toHaveLength(1);
  });
  it('rollover is detected AFTER the lock is released-to-default: lock_timeout is reset before the FY check throws', async () => {
    const { tx, calls } = fakeTx(healthy(0, NEW_FY));
    await svc.allocate(tx, { ...base, fiscalYearBs: '2081/82' }).catch(() => undefined);
    const upd = calls.findIndex((c) => UPD.test(c.sql));
    expect(calls.slice(upd + 1).some((c) => LOCK.test(c.sql) && /^0(ms)?$/.test(lockValue(c) ?? ''))).toBe(true);
  });
  it('rollover does not try to undo the counter itself (the caller’s rollback does): exactly one UPDATE, no decrement', async () => {
    const { tx, calls } = fakeTx(healthy(0, NEW_FY));
    await svc.allocate(tx, { ...base, fiscalYearBs: '2081/82' }).catch(() => undefined);
    expect(calls.filter((c) => UPD.test(c.sql))).toHaveLength(1);
    expect(calls.some((c) => /last_no\s*=\s*last_no\s*-/i.test(c.sql))).toBe(false);
  });
  it('the FY is judged in the tenant timezone: 18:15Z is already 2082/83 in Asia/Kathmandu but 2081/82 in UTC', async () => {
    const a = fakeTx(healthy(0, NEW_FY));
    await expect(svc.allocate(a.tx, { ...base, fiscalYearBs: '2081/82', timezone: 'UTC' })).resolves.toMatchObject({ lastNo: 1 });
    const b = fakeTx(healthy(0, NEW_FY));
    await expect(svc.allocate(b.tx, { ...base, fiscalYearBs: '2081/82' })).rejects.toMatchObject({ detail: 'fiscal_year_rollover' });
  });
});

describe('counter row missing / closed (TRD §12 step 2, 0-rows branch)', () => {
  it('0 rows → INSERT … (last_no 0) ON CONFLICT DO NOTHING → UPDATE retried once → number 1', async () => {
    let n = 0;
    const { tx, calls } = fakeTx((c) => (UPD.test(c.sql) ? (++n === 1 ? { rows: [] } : { rows: [{ last_no: 1, allocated_at: MID }] }) : undefined));
    await expect(svc.allocate(tx, base)).resolves.toMatchObject({ lastNo: 1 });
    const ins = calls.find((c) => INS.test(c.sql))!;
    expect(ins.sql).toMatch(/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i);
    expect(ins.values).toEqual(expect.arrayContaining([TENANT, 'INV', '2082/83']));
    expect(calls.filter((c) => UPD.test(c.sql))).toHaveLength(2);
    expect(calls.findIndex((c) => INS.test(c.sql))).toBeGreaterThan(calls.findIndex((c) => UPD.test(c.sql)));
  });
  it('still 0 rows after the INSERT (closed counter) → billing.fiscal_year_closed (409); never loops', async () => {
    const { tx, calls } = fakeTx(() => undefined);
    await expect(svc.allocate(tx, base)).rejects.toMatchObject({ code: 'billing.fiscal_year_closed', statusCode: 409 });
    expect(calls.filter((c) => UPD.test(c.sql))).toHaveLength(2);
    expect(calls.filter((c) => INS.test(c.sql))).toHaveLength(1);
  });
});

describe('series scope branch (US-BL-01.5; D-23) — pattern check is step 0: nothing allocated', () => {
  it.each(['{fy}-{seq:6}', '{seq:6}', 'INV-{fyl}-{seq:4}'])('INV:KTM with pattern %s (no {branch}) → billing.numbering_pattern_invalid, 409, ZERO queries', async (invoiceNoPattern) => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await expect(svc.allocate(tx, { ...base, series: 'INV:KTM', invoiceNoPattern })).rejects.toMatchObject({ code: 'billing.numbering_pattern_invalid', statusCode: 409 });
    expect(calls).toEqual([]);
  });
  it('INV:KTM without any pattern fails closed the same way (never allocates blind)', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await expect(svc.allocate(tx, { ...base, series: 'INV:KTM' })).rejects.toMatchObject({ code: 'billing.numbering_pattern_invalid' });
    expect(calls).toEqual([]);
  });
  it('INV:KTM with {branch} in the pattern allocates from its own series key', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await svc.allocate(tx, { ...base, series: 'INV:KTM', invoiceNoPattern: '{branch}/{fy}/{seq:6}' });
    expect(calls.find((c) => UPD.test(c.sql))!.values).toContain('INV:KTM');
  });
  it('tenant-scope series INV, and CN / RC, never need {branch} in the invoice pattern', async () => {
    for (const series of ['INV', 'CN', 'RC']) {
      const { tx } = fakeTx(healthy(0, MID));
      await expect(svc.allocate(tx, { ...base, series, invoiceNoPattern: '{fy}-{seq:6}' })).resolves.toMatchObject({ lastNo: 1 });
    }
  });
  it('{branch} must be a real token — text that merely contains the word does not count', async () => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await expect(svc.allocate(tx, { ...base, series: 'INV:KTM', invoiceNoPattern: 'branch-{fy}-{seq:6}' })).rejects.toMatchObject({ code: 'billing.numbering_pattern_invalid' });
    expect(calls).toEqual([]);
  });
});

describe('input validation (trust boundary; injection) — rejected before any SQL', () => {
  it.each([
    ['series injection', { series: "INV'; DROP TABLE billing.fiscal_counters;--" }],
    ['unknown series', { series: 'XYZ' }],
    ['empty series', { series: '' }],
    ['branch code too long', { series: 'INV:' + 'A'.repeat(21) }],
    ['branch code with space', { series: 'INV:KT M' }],
    ['fy wrong shape', { fiscalYearBs: '2082-83' }],
    ['fy injection', { fiscalYearBs: "2082/83' OR '1'='1" }],
    ['fy empty', { fiscalYearBs: '' }],
    ['tenant not a uuid', { tenantId: "x' OR 1=1" }],
    ['actor not a uuid', { actorId: 'root' }],
  ])('%s → common.validation_failed (400), zero queries', async (_n, over) => {
    const { tx, calls } = fakeTx(healthy(0, MID));
    await expect(svc.allocate(tx, { ...base, invoiceNoPattern: '{branch}-{seq:6}', ...over } as never)).rejects.toMatchObject({ code: 'common.validation_failed', statusCode: 400 });
    expect(calls).toEqual([]);
  });
});

describe('static rules (07-SECURITY counter row; TRD §12 "Gapless")', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === '__tests__' ? [] : walk(join(d, f))) : [join(d, f)]));
  const files = walk(root).filter((f) => /\.ts$/.test(f));
  const src = (f: string) => readFileSync(f, 'utf8');
  const svcSrc = src(join(root, 'service', 'counter.service.ts'));

  it('only counter.service.ts and repository/counters.repo.ts mention fiscal_counters in billing', () => {
    const hits = files.filter((f) => /fiscal_counters/.test(src(f))).map((f) => f.slice(root.length + 1).replaceAll('\\', '/')).sort();
    expect(hits).toEqual(['repository/counters.repo.ts', 'service/counter.service.ts']);
  });
  it('no Postgres SEQUENCE / nextval anywhere in billing (CI check, TRD §12)', () => {
    expect(files.filter((f) => /\bnextval\s*\(|CREATE\s+SEQUENCE/i.test(src(f)))).toEqual([]);
  });
  it('the service sets lock_timeout transaction-locally, reads clock_timestamp() in SQL, and names no template interpolation in SQL', () => {
    expect(svcSrc).toMatch(/set_config\(\s*'lock_timeout'/);
    expect(svcSrc).toMatch(/clock_timestamp\(\)/);
    expect(svcSrc).not.toMatch(/`[^`]*(fiscal_counters|set_config)[^`]*\$\{/);
    expect(svcSrc).not.toMatch(/\bSET\s+(LOCAL\s+)?lock_timeout/i);
  });
  it('no DELETE on fiscal_counters and no last_no assignment other than +1', () => {
    expect(svcSrc).not.toMatch(/DELETE\s+FROM\s+billing\.fiscal_counters/i);
    const assigns = [...svcSrc.matchAll(/\bSET\s+(?:[^`'"=]*,\s*)?last_no\s*=\s*([^,\s]+(?:\s*[+-]\s*\S+)?)/gi)].map((m) => m[1]!.replace(/\s+/g, ''));
    for (const a of assigns) expect(a).toMatch(/^last_no\+1$|^\$\d+$|^0$/);
  });
});
