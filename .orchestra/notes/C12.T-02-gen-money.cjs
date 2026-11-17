// Independent exact oracle for the money golden table (BigInt rational arithmetic, round half up).
// Run: node .orchestra/notes/C12.T-02-gen-money.cjs  -> prints rows pasted into money.test.ts. Not implementation code.
const rhu = (n, d) => (2n * n + d) / (2n * d);
const parse = (s) => {
  const [i, f = ''] = s.split('.');
  return [BigInt(i + f), 10n ** BigInt(f.length)];
};
const cases = [
  ['1', 100, 0, 1300], ['1', 100, 0, 0], ['10', 2500, 0, 1300], ['0.5', 1, 0, 0], ['1.5', 1, 0, 0],
  ['2.5', 1, 0, 0], ['0.001', 500, 0, 1300], ['0.002', 250, 0, 1300], ['3', 333, 33, 1300], ['3', 333, 999, 1300],
  ['12.5', 80, 0, 1300], ['12.5', 80, 100, 1300], ['0.333', 100, 0, 1300], ['0.667', 100, 0, 1300], ['100', 1, 0, 1300],
  ['1', 5, 0, 1300], ['1', 7, 0, 1300], ['1', 3, 0, 1300], ['1', 4, 0, 500], ['1', 10, 0, 500],
  ['1', 1, 0, 5000], ['1', 1, 0, 10000], ['1', 1, 1, 1300], ['2', 50, 100, 1300], ['999999999', 1, 0, 0],
  ['999999999', 1000, 0, 1300], ['1000.5', 99, 50, 1300], ['0.001', 1, 0, 0], ['0.999', 1, 0, 0], ['7', 12345, 345, 1300],
  ['4.25', 1999, 0, 1300], ['4.25', 1999, 2000, 1300], ['6', 8333, 0, 1300], ['0.1', 15, 0, 1300], ['250', 40, 0, 1300],
  ['1', 0, 0, 1300], ['5', 2, 10, 0], ['0.4', 25, 0, 1300],
];
for (const [q, p, d, bp] of cases) {
  const [qn, qd] = parse(q);
  const gross = rhu(qn * BigInt(p), qd);
  const net = gross - BigInt(d);
  if (net < 0n) { console.log('NEG', q, p, d); continue; }
  const vat = rhu(net * BigInt(bp), 10000n);
  console.log(`  { qty: '${q}', price: ${p}, disc: ${d}, bp: ${bp}, gross: ${gross}, net: ${net}, vat: ${vat}, total: ${net + vat} },`);
}
