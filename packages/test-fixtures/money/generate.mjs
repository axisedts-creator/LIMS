// Generates golden.json for T0A-07 (02-TRD §3.3). Expected values come from a BigInt reference here,
// never from the library under test. Run: node packages/test-fixtures/money/generate.mjs
import { writeFileSync } from 'node:fs';

const MAX = Number.MAX_SAFE_INTEGER;
let s = 0x0a07; // xorshift32, deterministic
const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
const ri = (n) => r() % n;

const pct = (a, bp) => Number((BigInt(a) * BigInt(bp) + 5000n) / 10000n);
function alloc(total, weights) {
  const T = BigInt(total), W = weights.map(BigInt), S = W.reduce((x, y) => x + y, 0n);
  const base = W.map((w) => (T * w) / S), rem = W.map((w) => (T * w) % S);
  let left = T - base.reduce((x, y) => x + y, 0n);
  const order = W.map((_, i) => i).sort((i, j) => (rem[j] > rem[i] ? 1 : rem[j] < rem[i] ? -1 : i - j));
  for (const i of order) { if (left === 0n) break; base[i] += 1n; left -= 1n; }
  return base.map(Number);
}
function fmt(a, grouping = 'lakh', symbol = 'Rs.') {
  const d = BigInt(a).toString().padStart(3, '0'), int = d.slice(0, -2);
  const g = int.length <= 3 ? int : grouping === 'international' ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + int.slice(-3);
  return `${symbol} ${g}.${d.slice(-2)}`;
}

const cases = [];
const push = (op, args, expected) => cases.push({ id: `${op}-${String(cases.filter((c) => c.op === op).length + 1).padStart(3, '0')}`, op, ...args, expected });
const P = (a, bp) => push('percentOf', { amountPaisa: a, bp }, pct(a, bp));

// percentOf: VAT 13% (1300 bp, 04 L14) incl. exact .5 ties (a ≡ 50 mod 100) and near-ties.
for (const a of [0, 1, 50, 100, 150, 250, 999, 10000, 12345, 38450, 99999, 150050, 1000000, 123456789, 4999950, MAX]) P(a, 1300);
for (let i = 0; i < 6; i++) P(50 + 100 * ri(1000000), 1300); // exact ties
for (let i = 0; i < 6; i++) P(1 + ri(100000000), 1300);
// line discounts (other bp), ties and near-ties
for (const [a, bp] of [[1, 5000], [3, 5000], [5, 1000], [3, 1666], [15, 3333], [25, 200], [125, 400], [1, 10000], [7, 2500], [9999, 1]]) P(a, bp);
for (const bp of [1, 50, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3333, 5000, 6667, 9999, 10000, 12000, 20000]) P(1 + ri(10000000), bp);
for (let i = 0; i < 12; i++) { // near-ties: a*bp % 10000 in {4999, 5001}
  for (;;) { const a = 1 + ri(1000000), bp = 1 + ri(9999), m = (a * bp) % 10000; if (m === 4999 || m === 5001) { P(a, bp); break; } }
}
for (let i = 0; i < 6; i++) { // more exact ties at random bp
  for (;;) { const a = 1 + ri(1000000), bp = 1 + ri(9999); if ((a * bp) % 10000 === 5000) { P(a, bp); break; } }
}
for (const bp of [1, 1300, 5000, 9999]) P(MAX, bp);

// mulQty
for (const [a, q] of [[0, 5], [1000, 0], [1000, 1], [12345, 3], [MAX, 1], [1, MAX], [99999, 1000], [4503599627370495, 2]]) push('mulQty', { amountPaisa: a, qty: q }, Number(BigInt(a) * BigInt(q)));
for (let i = 0; i < 17; i++) { const a = ri(100000000), q = ri(1000); push('mulQty', { amountPaisa: a, qty: q }, a * q); }

// add / sub (signed)
for (const xs of [[], [0], [5, 7, 8], [MAX], [MAX - 1, 1], [-MAX, MAX], [-5, 3]]) push('add', { amounts: xs }, Number(xs.reduce((t, x) => t + BigInt(x), 0n)));
for (let i = 0; i < 8; i++) { const xs = Array.from({ length: 1 + ri(6) }, () => ri(200000000) - 100000000); push('add', { amounts: xs }, xs.reduce((t, x) => t + x, 0)); }
for (const [a, b] of [[5, 5], [0, 1], [MAX, MAX], [-MAX, 0], [0, MAX], [100, 1300], [-1, -1]]) push('sub', { a, b }, a - b);
for (let i = 0; i < 8; i++) { const a = ri(200000000) - 100000000, b = ri(200000000) - 100000000; push('sub', { a, b }, a - b); }

// allocate (invoice-level discount allocation)
for (const [t, w] of [[100, [1, 1, 1]], [5, [1, 0, 1]], [0, [3, 4]], [1, [1, 1]], [2, [1, 1, 1]], [10, [1]], [MAX, [1, 1]], [MAX, [1, 2, 3, 4, 5]],
  [1000, [0, 0, 7]], [101, [50, 50]], [1300, [10000, 2500, 3300, 4200, 0, 1]], [7, [1, 1, 1, 1, 1, 1, 1, 1]], [99, [MAX, 1]]]) push('allocate', { totalPaisa: t, weights: w }, alloc(t, w));
for (let i = 0; i < 27; i++) {
  const w = Array.from({ length: 1 + ri(8) }, () => ri(100000)); if (w.every((x) => x === 0)) w[0] = 1;
  const t = ri(10000000); push('allocate', { totalPaisa: t, weights: w }, alloc(t, w));
}

// compare (signed)
for (const [a, b] of [[1, 2], [2, 2], [3, 2], [0, 0], [-1, 0], [0, -1], [MAX, -MAX], [-MAX, MAX], [MAX, MAX - 1]]) push('compare', { a, b }, a < b ? -1 : a > b ? 1 : 0);
for (let i = 0; i < 4; i++) { const a = ri(1000) - 500, b = ri(1000) - 500; push('compare', { a, b }, a < b ? -1 : a > b ? 1 : 0); }

// format (non-negative; negative display unspecified)
for (const a of [0, 5, 99, 100, 12345, 99999, 100000, 1234567, 123456789, 10000000000, MAX]) {
  push('format', { amountPaisa: a }, fmt(a));
  push('format', { amountPaisa: a, grouping: 'international' }, fmt(a, 'international'));
}
for (const a of [0, 123456789, MAX]) push('format', { amountPaisa: a, symbol: 'NPR' }, fmt(a, 'lakh', 'NPR'));
for (const a of [100000, 123456789]) push('format', { amountPaisa: a, grouping: 'lakh', symbol: 'NPR' }, fmt(a, 'lakh', 'NPR'));
push('format', { amountPaisa: 123456789, grouping: 'international', symbol: 'NPR' }, fmt(123456789, 'international', 'NPR'));

writeFileSync(new URL('golden.json', import.meta.url), JSON.stringify({
  note: 'SYNTHETIC. Generated by generate.mjs (02-TRD §3.3); do not hand-edit.', cases,
}, null, 1) + '\n');
console.log(`${cases.length} cases`);
