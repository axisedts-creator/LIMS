// Microbiology driver rule (02-TRD §6.1, CR-C10-007 / 08 R13): organism / AST records get a composite instrument_analyte_code so two isolates
// of one specimen carrying the same antibiotic never collide on the result idempotency key. Pure; never truncates (03-IC §3.14 maxLength 64).
import type { ParsedRecord } from './types.js';

export const MAX_ANALYTE_CODE_LENGTH = 64;
const TOO_LONG = 'instrument_analyte_code_too_long' as const;
export type MicroCode = { ok: true; code: string } | { ok: false; warning: typeof TOO_LONG };

const fit = (code: string): MicroCode => (code.length <= MAX_ANALYTE_CODE_LENGTH ? { ok: true, code } : { ok: false, warning: TOO_LONG });

/** `ORG:<isolateSeq|1>` */
export const orgCode = (isolateSeq?: number): MicroCode => fit(`ORG:${isolateSeq ?? 1}`);

/** `AST:<isolateSeq|1>:<antibiotic>:<method>` */
export const astCode = (a: { isolateSeq?: number; antibioticCodeRaw: string; method: 'mic' | 'zone_diameter' | 'other' }): MicroCode =>
  fit(`AST:${a.isolateSeq ?? 1}:${a.antibioticCodeRaw}:${a.method}`);

/** organism_id / ast records take the rule's code; too long => code left unset + warning (never truncated). Other records are returned as is. */
export function applyMicroCode(r: ParsedRecord): ParsedRecord {
  const c = r.recordKind === 'organism_id' && r.organism ? orgCode(r.organism.isolateSeq) : r.recordKind === 'ast' && r.ast ? astCode(r.ast) : undefined;
  if (!c) return r;
  if (c.ok) return { ...r, instrumentAnalyteCode: c.code };
  const { instrumentAnalyteCode: _dropped, ...rest } = r;
  return { ...rest, warnings: [...r.warnings, c.warning] };
}
