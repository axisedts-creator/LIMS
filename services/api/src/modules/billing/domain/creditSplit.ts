// Credit-note line amounts (03-APP-FLOW §2.11 B5): a credit of `net` paisa against one invoice line is split over exempt / taxable / VAT / other tax in
// proportion to what REMAINS of the line (largest remainder), so crediting the rest always lands exactly on the line (no cent drift) and every part
// satisfies credit_note_lines__amounts__ck (net = exempt + taxable + vat + other_tax; gross - discount = exempt + taxable). Pure; BigInt for the products.
export interface Parts { gross: number; discount: number; exempt: number; taxable: number; vat: number; otherTax: number; net: number }
const KEYS = ['exempt', 'taxable', 'vat', 'otherTax'] as const;

/** `remaining` = the line minus everything earlier credit notes took. Requires 1 <= net <= remaining.net. */
export function splitCredit(remaining: Parts, net: number): Parts {
  const R = BigInt(remaining.net), A = BigInt(net);
  if (net < 1 || A > R || R < 1n) throw new RangeError('credit out of range');
  if (A === R) return { ...remaining };
  const shares = KEYS.map((k, i) => { const n = A * BigInt(remaining[k]); return { k, i, floor: n / R, frac: n % R }; });
  let leftover = A - shares.reduce((s, x) => s + x.floor, 0n);
  for (const s of [...shares].sort((p, q) => (p.frac === q.frac ? p.i - q.i : p.frac > q.frac ? -1 : 1))) {
    if (leftover > 0n && s.frac > 0n) { s.floor += 1n; leftover -= 1n; } // frac > 0 => floor < remaining[k], so the cap holds
  }
  const part = Object.fromEntries(shares.map((s) => [s.k, Number(s.floor)])) as Record<(typeof KEYS)[number], number>;
  const base = part.exempt + part.taxable, remBase = remaining.exempt + remaining.taxable;
  const discount = remBase === 0 ? 0 : Number((BigInt(remaining.discount) * BigInt(base) * 2n + BigInt(remBase)) / (BigInt(remBase) * 2n)); // nearest
  const d = Math.min(discount, remaining.discount);
  return { ...part, discount: d, gross: base + d, net };
}
