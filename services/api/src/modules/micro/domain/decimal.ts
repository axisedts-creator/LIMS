// Exact decimals as scaled BigInt (10^6). Never IEEE floats (02-TRD §4.5).
const SCALE = 6;
const DECIMAL = /^[0-9]+(?:\.[0-9]{1,6})?$/;

export function parseDecimal(s: string): bigint {
  if (!DECIMAL.test(s)) throw new Error('decimal_malformed');
  const [int, frac = ''] = s.split('.');
  return BigInt(int + frac.padEnd(SCALE, '0'));
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
