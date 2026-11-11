// Placeholders: allowed per block kind, extraction, single-pass fill (02-TRD §4.9; AC-03.1, AC-03.4, AC-10.1).
export type BlockKind = 'deranged' | 'advice' | 'followup' | 'disclaimer' | 'score_explanation';

export const ALLOWED_PLACEHOLDERS: Readonly<Record<BlockKind, readonly string[]>> = {
  deranged: ['analyte_name', 'value', 'unit', 'ref_range', 'group_name'],
  advice: ['analyte_name', 'group_name'],
  followup: ['test_name', 'interval_days', 'group_name', 'analyte_name'],
  disclaimer: [],
  score_explanation: [],
};

const TOKEN = /\{([a-z_]+)\}/g;

/** Unique placeholder names, order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1] as string))];
}

/** Names used in `text` that are not allowed for `kind` (V4 placeholder_unknown). */
export function unknownPlaceholders(kind: BlockKind, text: string): string[] {
  const allowed = ALLOWED_PLACEHOLDERS[kind] ?? [];
  return extractPlaceholders(text).filter((n) => !allowed.includes(n));
}

/** Single pass (a value containing "{x}" is never re-expanded); throws if a used placeholder has no value. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string | undefined>>): string {
  return text.replace(TOKEN, (_m, name: string) => {
    const v = Object.hasOwn(values, name) ? values[name] : undefined;
    if (v === undefined) throw new Error(`placeholder_unresolvable: {${name}}`);
    return v;
  });
}

/** snapshot text, else "<low> – <high>", else "< <high>", else "> <low>" (same rule as C6-TRD §4.4). */
export function refRangeText(r: { low?: string; high?: string; text?: string }): string | undefined {
  if (r.text) return r.text;
  if (r.low && r.high) return `${r.low} – ${r.high}`;
  if (r.high) return `< ${r.high}`;
  if (r.low) return `> ${r.low}`;
  return undefined;
}

export interface DerangedValueSource {
  analyte: { name: string; printName?: string };
  result: { valueNumeric?: string; valueText?: string; ordinalCode?: string; unitCode?: string };
  referenceRangeSnapshot?: { low?: string; high?: string; text?: string };
  groupName: string;
}

/** Fill values for a `deranged` block; unavailable values are omitted so fillPlaceholders throws on use. */
export function derangedPlaceholderValues(s: DerangedValueSource): Record<string, string> {
  const out: Record<string, string> = { analyte_name: s.analyte.printName ?? s.analyte.name, group_name: s.groupName };
  const value = s.result.valueNumeric ?? s.result.valueText ?? s.result.ordinalCode;
  if (value !== undefined) out.value = value;
  if (s.result.unitCode !== undefined) out.unit = s.result.unitCode;
  const range = s.referenceRangeSnapshot && refRangeText(s.referenceRangeSnapshot);
  if (range !== undefined) out.ref_range = range;
  return out;
}
