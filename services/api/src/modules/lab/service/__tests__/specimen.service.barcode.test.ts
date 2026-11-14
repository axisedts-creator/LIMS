// C5 T-05 — barcode allocation in the service (02-TRD §4.2; 06 row T-05; AC-01.3, AC-01.4; 07-SECURITY REQ-SEC-024/095). No database: a recording fake tx stands in for the request transaction.
// Interface expected from the writer (../specimen.service.ts) — SEAM (spec fixes behaviour, not the name):
//   export async function allocateBarcode(ctx: LabCtx): Promise<string>
//     LabCtx = { tenantId: string; actor: { type: string; id: string }; tx: { query(text, values?): Promise<{ rows: any[] }> }; now(): Date;
//                ports: { IdentityPort: { getTenantSettings(ctx, { keys: string[] }): Promise<{ numbering?: { barcodePattern?: string; barcodePrefix?: string } }> } } }   (same ctx shape as billing/service/balance.service.ts)
//   Steps: pattern := getTenantSettings(ctx, { keys: ['numbering'] }).numbering.barcodePattern (absent -> '{prefix}{yy}{seq:8}', 08 A13 D-8), prefix := numbering.barcodePrefix (absent = '');
//          counter := allocateBarcodeSeq(repo; one `UPDATE lab.barcode_counters ... last_value + 1 ... RETURNING` in ctx.tx, tenant = ctx.tenantId); barcode := renderBarcode(pattern, { seq, prefix, now: ctx.now() }).
//   Any rendering problem -> LimsError('lab.barcode_pattern_invalid') (the caller's tx rolls back, so the counter step is undone with it).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { allocateBarcode } from '../specimen.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const OTHER = '01a1a98a-ac40-7000-8000-00000000b001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW_2026 = new Date('2026-06-15T05:00:00Z');

interface Numbering { barcodePattern?: string; barcodePrefix?: string }
interface Stmt { text: string; values: unknown[] }

function makeCtx(opts: { counter?: number; numbering?: Numbering | null; now?: Date; settings?: () => Promise<unknown> } = {}) {
  const stmts: Stmt[] = [];
  const settingsCalls: { ctx: unknown; input: unknown }[] = [];
  let counter = opts.counter ?? 41;
  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      if (/UPDATE\s+lab\.barcode_counters/i.test(text)) { counter += 1; return { rows: [{ last_value: String(counter) }] }; }
      return { rows: [] };
    },
  };
  const ctx = {
    tenantId: TENANT, actor: { type: 'system', id: ACTOR }, tx, now: () => opts.now ?? NOW_2026,
    ports: {
      IdentityPort: {
        async getTenantSettings(c: unknown, input: unknown) {
          settingsCalls.push({ ctx: c, input });
          if (opts.settings) return opts.settings();
          return opts.numbering === null ? {} : { numbering: opts.numbering ?? { barcodePrefix: 'E' } };
        },
      },
    },
  };
  return { ctx, stmts, settingsCalls, counter: () => counter };
}
const counterUpdates = (stmts: Stmt[]) => stmts.filter((s) => /UPDATE\s+lab\.barcode_counters/i.test(s.text));

describe('T-05 allocateBarcode: AC-01.3', () => {
  it('default pattern, prefix E, counter 41, 2026 -> E2600000042 (08 A13 D-8), matches ^[A-Z0-9]{1,20}$', async () => {
    const { ctx } = makeCtx({ counter: 41, numbering: { barcodePrefix: 'E' } });
    const v = await allocateBarcode(ctx as never);
    expect(v).toBe('E2600000042');
    expect(v).toMatch(/^[A-Z0-9]{1,20}$/);
  });
  it('reads exactly the numbering settings key through IdentityPort.getTenantSettings', async () => {
    const { ctx, settingsCalls } = makeCtx();
    await allocateBarcode(ctx as never);
    expect(settingsCalls).toHaveLength(1);
    expect(settingsCalls[0]!.input).toEqual({ keys: ['numbering'] });
  });
  it('numbering absent (no pattern, no prefix) -> default pattern with empty prefix', async () => {
    const { ctx } = makeCtx({ counter: 41, numbering: null });
    expect(await allocateBarcode(ctx as never)).toBe('2600000042');
  });
  it('pattern from settings is used (E{yy}{seq:8}); prefix is ignored when the pattern has no {prefix}', async () => {
    const { ctx } = makeCtx({ counter: 41, numbering: { barcodePattern: 'E{yy}{seq:8}', barcodePrefix: 'ZZ' } });
    expect(await allocateBarcode(ctx as never)).toBe('E2600000042');
  });
  it('{yy} comes from ctx.now() in Asia/Kathmandu (31 Dec 18:15Z is already next year there)', async () => {
    const { ctx } = makeCtx({ counter: 0, numbering: { barcodePrefix: 'E' }, now: new Date('2025-12-31T18:15:00Z') });
    expect(await allocateBarcode(ctx as never)).toBe('E2600000001');
  });
  it('consecutive allocations on one ctx are consecutive counter values', async () => {
    const { ctx } = makeCtx({ counter: 41 });
    expect([await allocateBarcode(ctx as never), await allocateBarcode(ctx as never), await allocateBarcode(ctx as never)])
      .toEqual(['E2600000042', 'E2600000043', 'E2600000044']);
  });
});

describe('T-05 allocateBarcode: counter statement (02-TRD §4.2; REQ-SEC-024)', () => {
  it('one atomic UPDATE ... last_value + 1 ... RETURNING per call, tenant bound from ctx (never interpolated), no other table touched', async () => {
    const { ctx, stmts } = makeCtx();
    await allocateBarcode(ctx as never);
    const ups = counterUpdates(stmts);
    expect(ups).toHaveLength(1);
    expect(ups[0]!.text).toMatch(/last_value\s*=\s*last_value\s*\+\s*1/i);
    expect(ups[0]!.text).toMatch(/RETURNING/i);
    expect(ups[0]!.values[0]).toBe(TENANT);
    for (const s of stmts) {
      expect(s.text).toMatch(/lab\.barcode_counters/);
      expect(s.text).not.toContain(TENANT);
    }
  });
  it('tenant comes from ctx; a tenant id smuggled inside the settings is ignored', async () => {
    const { ctx, stmts } = makeCtx({ settings: async () => ({ numbering: { barcodePrefix: 'E', tenantId: OTHER, tenant_id: OTHER } }) });
    await allocateBarcode(ctx as never);
    expect(stmts.every((s) => !s.values.includes(OTHER))).toBe(true);
  });
});

describe('T-05 allocateBarcode: AC-01.4 invalid configuration or overflow -> lab.barcode_pattern_invalid', () => {
  const failing = async (numbering: Numbering, counter = 41) => {
    const h = makeCtx({ counter, numbering });
    let err: unknown;
    try { await allocateBarcode(h.ctx as never); } catch (e) { err = e; }
    return { err, ...h };
  };

  it('charset: lowercase / punctuation in the pattern', async () => {
    for (const barcodePattern of ['e{yy}{seq:8}', 'E-{yy}{seq:8}', 'E {seq:8}']) {
      const { err } = await failing({ barcodePattern });
      expect(isLimsError(err, 'lab.barcode_pattern_invalid'), barcodePattern).toBe(true);
    }
  });
  it('length: rendered value > 20 characters', async () => {
    const { err } = await failing({ barcodePattern: 'ABCDEFGHIJKLM{seq:8}' });
    expect(isLimsError(err, 'lab.barcode_pattern_invalid')).toBe(true);
  });
  it('{branch} {centre} {fy} {fyl} are rejected', async () => {
    for (const t of ['{branch}', '{centre}', '{fy}', '{fyl}']) {
      const { err } = await failing({ barcodePattern: `${t}{seq:8}` });
      expect(isLimsError(err, 'lab.barcode_pattern_invalid'), t).toBe(true);
    }
  });
  it('prefix value outside [A-Z0-9]{0,4}', async () => {
    const { err } = await failing({ barcodePrefix: 'abcde' });
    expect(isLimsError(err, 'lab.barcode_pattern_invalid')).toBe(true);
  });
  it('counter overflow: next value needs 9 digits but the pattern has {seq:8}', async () => {
    const { err } = await failing({ barcodePrefix: 'E' }, 99999999);   // allocated value 100000000
    expect(isLimsError(err, 'lab.barcode_pattern_invalid')).toBe(true);
  });
  it('last value that still fits is allocated (99999999 -> E2699999999 is 11 chars, ok)', async () => {
    const { ctx } = makeCtx({ counter: 99999998, numbering: { barcodePrefix: 'E' } });
    expect(await allocateBarcode(ctx as never)).toBe('E2699999999');
  });
  it('the error is a 500 problem without the pattern, prefix or counter in message/detail', async () => {
    const { err } = await failing({ barcodePattern: 'SECRETLIT{branch}{seq:8}', barcodePrefix: 'ZZ9' }, 4242);
    const e = err as { statusCode: number; message: string; detail?: string; errors?: unknown };
    expect(e.statusCode).toBe(500);
    const dump = JSON.stringify({ m: e.message, d: e.detail, errors: e.errors });
    for (const s of ['SECRETLIT', '{branch}', 'ZZ9', '4243']) expect(dump).not.toContain(s);
  });
  it('no specimen (or any other lab table) is written on failure', async () => {
    const { stmts } = await failing({ barcodePattern: 'e{seq:8}' });
    expect(stmts.every((s) => !/specimens|INSERT\s+INTO\s+lab\.(?!barcode_counters)/i.test(s.text))).toBe(true);
  });
});

describe('T-05 allocateBarcode: dependency failure', () => {
  it('IdentityPort failure propagates unchanged (no fallback to the default pattern)', async () => {
    const boom = Object.assign(new Error('identity down'), { code: 'common.upstream_unavailable' });
    const { ctx } = makeCtx({ settings: async () => { throw boom; } });
    await expect(allocateBarcode(ctx as never)).rejects.toBe(boom);
  });
  it('a database failure on the counter propagates (never a made-up barcode)', async () => {
    const { ctx } = makeCtx();
    const dbErr = new Error('connection terminated');
    (ctx.tx as { query: unknown }).query = async () => { throw dbErr; };
    await expect(allocateBarcode(ctx as never)).rejects.toBe(dbErr);
  });
  it('a counter row that returns nothing is an error, not "undefined" in a barcode', async () => {
    const { ctx } = makeCtx();
    (ctx.tx as { query: unknown }).query = async () => ({ rows: [] });
    await expect(allocateBarcode(ctx as never)).rejects.toThrow();
  });
  it('missing tenant / actor / tx in ctx is rejected before any statement', async () => {
    const { ctx, stmts } = makeCtx();
    await expect(allocateBarcode({ ...ctx, tenantId: undefined } as never)).rejects.toThrow();
    await expect(allocateBarcode({ ...ctx, actor: undefined } as never)).rejects.toThrow();
    await expect(allocateBarcode({ ...ctx, tx: undefined } as never)).rejects.toThrow();
    expect(stmts).toHaveLength(0);
  });
});
