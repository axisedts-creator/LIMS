// T0B-SYNC-2 done_when (8) PROPERTY: out of order, shuffled, batched and re-delivered append only operations end in the same state (seeded, reproducible: no fast-check in this repo).
// Fails today: createSyncPart2Handlers does not exist.
import { describe, expect, it } from 'vitest';
import { A1, devicePush, effects, engine, iso, ledger, newDevice, NOW, okBody, op, uid } from './helpers2.js';

const T = 300_000;
const H = engine();
// mulberry32: tiny seeded PRNG
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = <X>(a: X[], r: () => number): X[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; };

const N = 14;
/** The operation set, identical for every trial except the ids (index k keeps its tag, its time and its kind). */
function make(): any[] {
  return Array.from({ length: N }, (_, k) => {
    const at = new Date(NOW.getTime() - 86_400_000 + k * 60_000);
    if (k % 5 === 4) return op('billing.record_receipt', { entity_id: uid(), payload: { tag: `k${k}`, numbers: true, n: k } }, at);
    if (k === 7) return op('result.enter', { payload: { tag: `k${k}`, fail: 'lab.result_locked' } }, at);       // the same operation is rejected in every delivery
    return op('result.enter', { payload: { tag: `k${k}` } }, at);
  });
}
const signature = async (ops: any[]): Promise<string> => {
  const l = await ledger(ops.map((o) => o.op_id));
  const fx = await effects(ops.map((o) => o.op_id));
  const idx = (id: string) => ops.findIndex((o) => o.op_id === id);
  return JSON.stringify({
    ledger: l.map((x) => [idx(x.op_id), x.status, x.error_code, x.result?.entity_id ?? null, (x.result?.number_mappings ?? []).map((m: any) => m.provisional_number)]).sort((a, b) => a[0] - b[0]),
    effects: fx.map((x) => [idx(x.op_id), x.tag, x.entity_id ? 'e' : '-']).sort((a, b) => a[0] - b[0]),
  });
};
type Delivery = (ops: any[], r: () => number) => any[][];
const DELIVERIES: Record<string, Delivery> = {
  'one sorted batch': (ops) => [ops],
  'reverse order, batches of 4': (ops) => { const b = [...ops].reverse(); return [b.slice(0, 4), b.slice(4, 8), b.slice(8, 12), b.slice(12)]; },
  'shuffled, one batch': (ops, r) => [shuffle(ops, r)],
  'shuffled, random batch sizes': (ops, r) => { const s = shuffle(ops, r); const out: any[][] = []; let i = 0; while (i < s.length) { const n = 1 + Math.floor(r() * 5); out.push(s.slice(i, i + n)); i += n; } return out; },
  'shuffled with every batch delivered twice and a full replay at the end': (ops, r) => { const s = shuffle(ops, r); const parts = [s.slice(0, 6), s.slice(6)]; return [...parts, ...parts, shuffle(ops, r)]; },
};

describe('append only operations converge whatever the delivery (property, 5 seeds x 5 deliveries)', () => {
  it.each([1, 7, 42, 1001, 20261117])('seed %i: every delivery ends in the same ledger and the same effects, each operation executed exactly once', async (seed) => {
    const r = rng(seed);
    const template = make();
    const sigs: Record<string, string> = {};
    for (const [name, deliver] of Object.entries(DELIVERIES)) {
      const dev = await newDevice(A1);
      const ops = template.map((o) => ({ ...o, op_id: uid() }));   // fresh ids per trial, same content and times
      for (const batch of deliver(ops, r)) okBody(await devicePush(H, A1, dev, batch));
      sigs[name] = await signature(ops);
      const fx = await effects(ops.map((o) => o.op_id));
      expect(new Set(fx.map((x) => x.op_id)).size, `${name}: one effect per operation`).toBe(fx.length);
      expect(fx.length, name).toBe(N - 1);                           // k = 7 is rejected and rolled back
      expect(await ledger(ops.map((o) => o.op_id)), name).toHaveLength(N);
    }
    const [first, ...rest] = Object.values(sigs);
    for (const s of rest) expect(s).toBe(first);
    expect(JSON.parse(first!).ledger[7].slice(1, 3)).toEqual(['rejected', 'lab.result_locked']);
  }, T);

  it('two devices of one user delivering the same operations in different orders end in one state (op_id is the key per tenant)', async () => {
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    const ops = make().map((o) => ({ ...o, op_id: uid() }));
    const r = rng(99);
    for (const batch of shuffle(ops, r).reduce<any[][]>((a, o, i) => { (a[Math.floor(i / 5)] ??= []).push(o); return a; }, [])) okBody(await devicePush(H, A1, d1, batch));
    for (const batch of shuffle(ops, r).reduce<any[][]>((a, o, i) => { (a[Math.floor(i / 7)] ??= []).push(o); return a; }, [])) okBody(await devicePush(H, A1, d2, batch));
    expect((await effects(ops.map((o) => o.op_id))).length).toBe(N - 1);
    expect(iso(NOW)).toBeTruthy();
  }, T);
});
