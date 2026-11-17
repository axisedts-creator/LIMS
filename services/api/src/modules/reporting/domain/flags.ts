// Flag and value formatting (02-TRD §4.4; AC-02.7). Pure.
export type ResultFlag = 'N' | 'H' | 'L' | 'HH' | 'LL' | 'A';
export type FlagLabel = 'High' | 'Low' | 'Critical High' | 'Critical Low' | 'Abnormal';

export function formatFlag(flag: ResultFlag | undefined, opts: { printCriticalLabel?: boolean } = {}): { flagLabel?: FlagLabel; valueBold: boolean } {
  const crit = opts.printCriticalLabel === true;
  switch (flag) {
    case 'H': return { flagLabel: 'High', valueBold: true };
    case 'L': return { flagLabel: 'Low', valueBold: true };
    case 'HH': return { flagLabel: crit ? 'Critical High' : 'High', valueBold: true };
    case 'LL': return { flagLabel: crit ? 'Critical Low' : 'Low', valueBold: true };
    case 'A': return { flagLabel: 'Abnormal', valueBold: true };
    default: return { valueBold: false };
  }
}

export function methodLine(methodName: string | undefined): string | undefined {
  return methodName?.trim() ? `METHOD : ${methodName}` : undefined;
}

/** Snapshot text, else "low – high", else "< high" / "> low". */
export function formatRefRange(r: { text?: string; low?: string; high?: string }): string | undefined {
  if (r.text) return r.text;
  if (r.low && r.high) return `${r.low} – ${r.high}`;
  if (r.high) return `< ${r.high}`;
  if (r.low) return `> ${r.low}`;
  return undefined;
}
