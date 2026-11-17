// T0A-07 / AC-0A-4.1, 4.2, 4.3 (TRD §3.3 Money; CV §4.9). See .orchestra/notes/T0A-07-tests.md.
// ASSUMED (spec names the functions; the rest is test-side convention):
//   src/money/index.ts exports paisa, money, add(...m), sub, mulQty, percentOf, allocate, compare, isZero, format
//   Money = { amountPaisa: number, currency: 'NPR' }
//   fixture packages/test-fixtures/money/golden.json = { "cases": [ { id, op, ...args, expected } ] } with ops:
//     percentOf {amountPaisa, bp, expected}   mulQty {amountPaisa, qty, expected}
//     add {amounts:[..], expected}            sub {a, b, expected}
//     allocate {totalPaisa, weights:[..], expected:[..]}   (largest remainder, ties -> lowest index)
//     compare {a, b, expected: -1|0|1}        format {amountPaisa, grouping?, symbol?, expected}
//   All amounts/expected are safe-integer paisa; fixture rows only use non-negative amounts for percentOf/mulQty/allocate/format.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = new URL('../src/money/', import.meta.url);
const GOLDEN = new URL('../../test-fixtures/money/golden.json', import.meta.url);
const load = () => import(new URL('index.ts', DIR).href);
const MAX = Number.MAX_SAFE_INTEGER;
const MAXN = BigInt(MAX);

// ---------- independent BigInt oracle (no floats, no impl code) ----------
const pctO = (a, bp) => (BigInt(a) * BigInt(bp) + 5000n) / 10000n; // half-up, a >= 0
function allocO(total, weights) {
  const T = BigInt(total), W = weights.map(BigInt), S = W.reduce((x, y) => x + y, 0n);
  const base = W.map((w) => (T * w) / S), rem = W.map((w) => (T * w) % S);
  let left = T - base.reduce((x, y) => x + y, 0n);
  const order = W.map((_, i) => i).sort((i, j) => (rem[j] > rem[i] ? 1 : rem[j] < rem[i] ? -1 : i - j));
  for (const i of order) { if (left <= 0n) break; base[i] += 1n; left -= 1n; }
  return base.map(Number);
}
function groupO(intStr, grouping) {
  if (intStr.length <= 3) return intStr;
  if (grouping === 'international') return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const head = intStr.slice(0, -3), tail = intStr.slice(-3);
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail;
}
function formatO(a, grouping = 'lakh', symbol = 'Rs.') {
  const s = BigInt(a).toString().padStart(3, '0');
  return `${symbol} ${groupO(s.slice(0, -2), grouping)}.${s.slice(-2)}`;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(0x7a0a07);
const rbig = (maxBits) => { // random safe integer with random bit-length 0..maxBits
  const bits = Math.floor(rnd() * (maxBits + 1));
  let v = 0n;
  for (let i = 0; i < bits; i++) v = (v << 1n) | (rnd() < 0.5 ? 1n : 0n);
  return Number(v > MAXN ? MAXN : v);
};

const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8')).cases;
const M = (api, n) => api.money(n);

describe('AC-0A-4.1 paisa()/money() reject non-integers and unsafe values', () => {
  it('money(1.5) throws; money(MAX_SAFE+1) throws; boundaries accepted', async () => {
    const api = await load();
    assert.throws(() => api.money(1.5));
    assert.throws(() => api.money(MAX + 1));
    assert.throws(() => api.money(-MAX - 1));
    assert.equal(api.money(MAX).amountPaisa, MAX);
    assert.equal(api.money(-MAX).amountPaisa, -MAX);
    assert.deepEqual(api.money(12345), { amountPaisa: 12345, currency: 'NPR' });
  });
  it('paisa() rejects NaN, Infinity, fractions, strings, null, bigint', async () => {
    const api = await load();
    for (const bad of [NaN, Infinity, -Infinity, 0.1, -0.5, 2 ** 53, '100', null, undefined, 10n, {}])
      assert.throws(() => api.paisa(bad), undefined, `paisa(${String(bad)})`);
    assert.equal(api.paisa(0), 0);
    assert.equal(api.paisa(MAX), MAX);
  });
  it('mulQty rejects fractional/negative/unsafe qty and unsafe product', async () => {
    const api = await load();
    const m = M(api, 1000);
    for (const q of [1.5, -1, NaN, Infinity, MAX + 1, '2']) assert.throws(() => api.mulQty(m, q), undefined, `qty ${String(q)}`);
    assert.equal(api.mulQty(m, 0).amountPaisa, 0);
    assert.throws(() => api.mulQty(M(api, MAX), 2), 'product above safe range');
    assert.equal(api.mulQty(M(api, MAX), 1).amountPaisa, MAX);
  });
  it('percentOf rejects fractional/negative/non-number basis points', async () => {
    const api = await load();
    const m = M(api, 10000);
    for (const bp of [12.5, -1, NaN, Infinity, '1300', null]) assert.throws(() => api.percentOf(m, bp), undefined, `bp ${String(bp)}`);
    assert.equal(api.percentOf(m, 0).amountPaisa, 0);
    assert.equal(api.percentOf(m, 1300).amountPaisa, 1300);
  });
  it('add/sub throw when the result leaves the safe range; add() of nothing is zero', async () => {
    const api = await load();
    assert.throws(() => api.add(M(api, MAX), M(api, 1)));
    assert.throws(() => api.sub(M(api, -MAX), M(api, 1)));
    assert.equal(api.add().amountPaisa, 0);
    assert.equal(api.add(M(api, 5), M(api, 7), M(api, 8)).amountPaisa, 20);
    assert.equal(Object.is(api.sub(M(api, 5), M(api, 5)).amountPaisa, 0), true, 'no negative zero');
  });
  it('allocate rejects empty, negative, fractional, all-zero weights; bad total', async () => {
    const api = await load();
    const t = M(api, 100);
    for (const w of [[], [0, 0], [-1, 2], [1.5, 1], [NaN, 1], [MAX + 1, 1]]) assert.throws(() => api.allocate(t, w), undefined, JSON.stringify(w));
    assert.throws(() => api.allocate(M(api, -1), [1, 1]));
  });
  it('compare / isZero', async () => {
    const api = await load();
    assert.equal(api.compare(M(api, 1), M(api, 2)), -1);
    assert.equal(api.compare(M(api, 2), M(api, 2)), 0);
    assert.equal(api.compare(M(api, 3), M(api, 2)), 1);
    assert.equal(api.isZero(M(api, 0)), true);
    assert.equal(api.isZero(M(api, 1)), false);
  });
});

describe('AC-0A-4.2 golden fixture (TS side)', () => {
  it('fixture has >= 200 cases, unique ids, op coverage, VAT 1300 bp, half-up ties', () => {
    const cs = golden();
    assert.ok(cs.length >= 200, `only ${cs.length} cases`);
    assert.equal(new Set(cs.map((c) => c.id)).size, cs.length, 'ids unique');
    const n = (op) => cs.filter((c) => c.op === op).length;
    const mins = { percentOf: 60, mulQty: 20, add: 10, sub: 10, allocate: 30, compare: 10, format: 20 };
    for (const [op, min] of Object.entries(mins)) assert.ok(n(op) >= min, `op ${op}: ${n(op)} < ${min}`);
    assert.ok(cs.every((c) => c.op in mins), 'only known ops');
    const pc = cs.filter((c) => c.op === 'percentOf');
    assert.ok(pc.filter((c) => c.bp === 1300).length >= 20, '>= 20 VAT (1300 bp) cases');
    assert.ok(pc.filter((c) => c.bp !== 1300).length >= 20, '>= 20 line-discount cases (other bp)');
    const ties = pc.filter((c) => (BigInt(c.amountPaisa) * BigInt(c.bp)) % 10000n === 5000n);
    assert.ok(ties.length >= 10, `>= 10 exact .5 ties, got ${ties.length}`);
    assert.ok(pc.some((c) => (BigInt(c.amountPaisa) * BigInt(c.bp)) % 10000n === 4999n || (BigInt(c.amountPaisa) * BigInt(c.bp)) % 10000n === 5001n), 'near-tie rows');
    assert.ok(cs.filter((c) => c.op === 'allocate').some((c) => c.weights.length >= 5), 'an allocation over >= 5 weights');
  });

  it('every fixture row agrees with the independent BigInt oracle (fixture is not self-referential)', () => {
    for (const c of golden()) {
      const id = c.id;
      switch (c.op) {
        case 'percentOf': assert.equal(BigInt(c.expected), pctO(c.amountPaisa, c.bp), id); break;
        case 'mulQty': assert.equal(BigInt(c.expected), BigInt(c.amountPaisa) * BigInt(c.qty), id); break;
        case 'add': assert.equal(BigInt(c.expected), c.amounts.reduce((s, x) => s + BigInt(x), 0n), id); break;
        case 'sub': assert.equal(BigInt(c.expected), BigInt(c.a) - BigInt(c.b), id); break;
        case 'compare': assert.equal(c.expected, c.a < c.b ? -1 : c.a > c.b ? 1 : 0, id); break;
        case 'allocate': assert.deepEqual(c.expected, allocO(c.totalPaisa, c.weights), id); break;
        case 'format': assert.equal(c.expected, formatO(c.amountPaisa, c.grouping, c.symbol), id); break;
        default: assert.fail(`unknown op ${c.op}`);
      }
      const nums = [c.amountPaisa, c.a, c.b, c.qty, c.bp, c.totalPaisa, ...(c.amounts ?? []), ...(c.weights ?? []), ...(Array.isArray(c.expected) ? c.expected : c.op === 'format' ? [] : [c.expected])];
      for (const v of nums.filter((x) => x !== undefined)) assert.ok(Number.isSafeInteger(v), `${id}: ${v} is not a safe integer`);
    }
  });

  it('impl reproduces every golden case exactly', async () => {
    const api = await load();
    for (const c of golden()) {
      let got;
      switch (c.op) {
        case 'percentOf': got = api.percentOf(M(api, c.amountPaisa), c.bp).amountPaisa; break;
        case 'mulQty': got = api.mulQty(M(api, c.amountPaisa), c.qty).amountPaisa; break;
        case 'add': got = api.add(...c.amounts.map((x) => M(api, x))).amountPaisa; break;
        case 'sub': got = api.sub(M(api, c.a), M(api, c.b)).amountPaisa; break;
        case 'compare': got = api.compare(M(api, c.a), M(api, c.b)); break;
        case 'allocate': got = api.allocate(M(api, c.totalPaisa), c.weights).map((m) => m.amountPaisa); break;
        case 'format': got = api.format(M(api, c.amountPaisa), { ...(c.grouping && { grouping: c.grouping }), ...(c.symbol && { symbol: c.symbol }) }); break;
      }
      assert.deepEqual(got, c.expected, c.id);
    }
  });
});

describe('spec examples', () => {
  it('VAT 13% half-up; line discount; format lakh default', async () => {
    const api = await load();
    assert.equal(api.percentOf(M(api, 10000), 1300).amountPaisa, 1300);
    assert.equal(api.percentOf(M(api, 1), 5000).amountPaisa, 1, '0.5 -> 1 (half-up)');
    assert.equal(api.percentOf(M(api, 3), 1666).amountPaisa, 0, '0.4998 -> 0');
    assert.equal(api.percentOf(M(api, 5), 1000).amountPaisa, 1, '0.5 -> 1');
    assert.equal(api.format(M(api, 123456789)), 'Rs. 12,34,567.89');
    assert.equal(api.format(M(api, 123456789), { grouping: 'international' }), 'Rs. 1,234,567.89');
    assert.equal(api.format(M(api, 123456789), { symbol: 'NPR' }), 'NPR 12,34,567.89');
    assert.equal(api.format(M(api, 5)), 'Rs. 0.05');
    assert.equal(api.format(M(api, 0)), 'Rs. 0.00');
  });
  it('allocate: largest remainder, sum preserved, ties to lowest index', async () => {
    const api = await load();
    const r = api.allocate(M(api, 100), [1, 1, 1]).map((m) => m.amountPaisa);
    assert.deepEqual(r, [34, 33, 33]);
    assert.deepEqual(api.allocate(M(api, 5), [1, 0, 1]).map((m) => m.amountPaisa), [3, 0, 2]);
    assert.deepEqual(api.allocate(M(api, 0), [3, 4]).map((m) => m.amountPaisa), [0, 0]);
  });
});

describe('AC-0A-4.3 fuzz: no non-integer / imprecise intermediate, results equal BigInt oracle', () => {
  const N = 3000;
  it('percentOf over the whole safe range (throws exactly when the result is unsafe)', async () => {
    const api = await load();
    for (let i = 0; i < N; i++) {
      const a = rbig(53), bp = Math.floor(rnd() * 20001);
      const want = pctO(a, bp);
      if (want > MAXN) assert.throws(() => api.percentOf(M(api, a), bp), undefined, `${a} x ${bp}`);
      else {
        const got = api.percentOf(M(api, a), bp).amountPaisa;
        assert.ok(Number.isSafeInteger(got), `non-integer result for ${a} x ${bp}`);
        assert.equal(BigInt(got), want, `${a} x ${bp}`);
      }
    }
  });
  it('percentOf at MAX_SAFE with VAT/discount bps (product a*bp exceeds 2^53 internally)', async () => {
    const api = await load();
    for (const bp of [1, 1300, 5000, 9999, 10000]) assert.equal(BigInt(api.percentOf(M(api, MAX), bp).amountPaisa), pctO(MAX, bp), `bp ${bp}`);
  });
  it('mulQty', async () => {
    const api = await load();
    for (let i = 0; i < N; i++) {
      const a = rbig(53), q = rbig(30), want = BigInt(a) * BigInt(q);
      if (want > MAXN) assert.throws(() => api.mulQty(M(api, a), q), undefined, `${a} x ${q}`);
      else assert.equal(BigInt(api.mulQty(M(api, a), q).amountPaisa), want, `${a} x ${q}`);
    }
  });
  it('add / sub', async () => {
    const api = await load();
    for (let i = 0; i < N; i++) {
      const xs = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => rbig(50));
      const want = xs.reduce((s, x) => s + BigInt(x), 0n);
      if (want > MAXN) assert.throws(() => api.add(...xs.map((x) => M(api, x))));
      else assert.equal(BigInt(api.add(...xs.map((x) => M(api, x))).amountPaisa), want);
      const [a, b] = [rbig(53), rbig(53)];
      assert.equal(BigInt(api.sub(M(api, a), M(api, b)).amountPaisa), BigInt(a) - BigInt(b));
    }
  });
  it('allocate: oracle equal, sum(result) === total, every share within 1 of exact', async () => {
    const api = await load();
    for (let i = 0; i < N; i++) {
      const total = rbig(i % 3 === 0 ? 53 : 40);
      const weights = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => rbig(i % 2 ? 53 : 12));
      if (weights.every((w) => w === 0)) weights[0] = 1;
      const got = api.allocate(M(api, total), weights).map((m) => m.amountPaisa);
      assert.ok(got.every(Number.isSafeInteger), 'integers only');
      assert.equal(got.reduce((s, x) => s + BigInt(x), 0n), BigInt(total), 'sum preserved');
      assert.deepEqual(got, allocO(total, weights), `total ${total} weights ${weights}`);
    }
  });
  it('format matches the oracle for random non-negative amounts, both groupings', async () => {
    const api = await load();
    for (let i = 0; i < 1000; i++) {
      const a = rbig(53), grouping = i % 2 ? 'lakh' : 'international';
      assert.equal(api.format(M(api, a), { grouping }), formatO(a, grouping));
    }
  });
});

describe('AC-0A-4.3 static: money sources contain no float arithmetic', () => {
  const files = () => {
    const out = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(f) && out.push(p); } };
    walk(fileURLToPath(DIR));
    return out;
  };
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
  it('no Math.round/toFixed/parseFloat/Math.random and no decimal literals', () => {
    const fs = files();
    assert.ok(fs.length >= 1, 'src/money/*.ts exists');
    for (const f of fs) {
      const src = strip(readFileSync(f, 'utf8'));
      assert.doesNotMatch(src, /Math\.(round|random|fround)|toFixed|parseFloat/, f);
      assert.doesNotMatch(src, /(?<![\w.])\d+\.\d+(?![\w.])|(?<![\w.])\.\d+(?!\w)/, `${f}: decimal literal`);
    }
  });
});
