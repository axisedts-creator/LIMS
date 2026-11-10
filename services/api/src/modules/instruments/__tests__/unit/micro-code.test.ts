// C7 API-T16 — AC-11.4 / CR-C10-007 (08 R13): microbiology driver rule in drivers/micro-code.ts (02-TRD 6.1). Pure helper, golden-file tested.
// SEAM the spec leaves open (writer must match, or raise a dispute) — `../../drivers/micro-code.js` exports:
//   MAX_ANALYTE_CODE_LENGTH = 64
//   type MicroCode = { ok: true; code: string } | { ok: false; warning: 'instrument_analyte_code_too_long' }
//   orgCode(isolateSeq?: number): MicroCode                                              'ORG:' + (isolateSeq ?? 1)
//   astCode(a: { isolateSeq?: number; antibioticCodeRaw: string; method: 'mic'|'zone_diameter'|'other' }): MicroCode   'AST:<seq|1>:<ab>:<method>'
//   applyMicroCode(r: ParsedRecord): ParsedRecord   organism_id / ast records get instrumentAnalyteCode from the rule; if too long the code is left
//                                                    UNSET (never truncated) and the warning is appended to r.warnings; every other record is returned unchanged.
// Golden cases: __tests__/fixtures/micro-code.golden.json ("X{n}" = n repetitions of X).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_ANALYTE_CODE_LENGTH, applyMicroCode, astCode, orgCode } from '../../drivers/micro-code.js';
import type { ParsedRecord } from '../../drivers/types.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/micro-code.golden.json', import.meta.url), 'utf8'));
const expand = (s: string) => s.replace(/(\w)\{(\d+)\}/g, (_m, c: string, n: string) => c.repeat(Number(n)));
const seq = (v: number | null) => (v === null ? undefined : v);
const base = (o: Partial<ParsedRecord> = {}): ParsedRecord => ({ recordSeq: 1, recordClass: 'patient', sampleBarcode: 'E2600000042', instrumentFlags: [], warnings: [], ...o });
const WARN = 'instrument_analyte_code_too_long';

describe('constants', () => { it('limit is 64 (03-IC 3.14 instrument_analyte_code maxLength)', () => { expect(MAX_ANALYTE_CODE_LENGTH).toBe(64); }); });

describe('orgCode — golden', () => {
  it.each(golden.org)('$name', (c: any) => { expect(orgCode(seq(c.isolateSeq))).toEqual({ ok: true, code: c.code }); });
});

describe('astCode — golden', () => {
  it.each(golden.ast)('$name', (c: any) => {
    const got = astCode({ ...(c.isolateSeq === null ? {} : { isolateSeq: c.isolateSeq }), antibioticCodeRaw: expand(c.ab), method: c.method });
    if (c.tooLong) expect(got).toEqual({ ok: false, warning: WARN });
    else { expect(got).toEqual({ ok: true, code: expand(c.code) }); expect((got as any).code.length).toBeLessThanOrEqual(64); }
  });
  it('a rejected code never carries a (truncated) value and the warning never echoes the antibiotic code (no value in logs)', () => {
    const got = astCode({ isolateSeq: 1, antibioticCodeRaw: 'SECRETAB'.repeat(8), method: 'mic' });
    expect(got.ok).toBe(false); expect(JSON.stringify(got)).not.toContain('SECRETAB'); expect(Object.keys(got).sort()).toEqual(['ok', 'warning']);
  });
});

describe('AC-11.4 — two isolates of one specimen carrying the same antibiotic give two distinct codes', () => {
  it('AST:1:<ab>:<method> and AST:2:<ab>:<method>', () => {
    const a = astCode({ isolateSeq: 1, antibioticCodeRaw: 'AMP', method: 'mic' }), b = astCode({ isolateSeq: 2, antibioticCodeRaw: 'AMP', method: 'mic' });
    expect(a).toEqual({ ok: true, code: 'AST:1:AMP:mic' }); expect(b).toEqual({ ok: true, code: 'AST:2:AMP:mic' });
  });
  it('the same antibiotic with a different method is a different code too (mic vs zone_diameter)', () => {
    expect((astCode({ isolateSeq: 1, antibioticCodeRaw: 'AMP', method: 'mic' }) as any).code).not.toBe((astCode({ isolateSeq: 1, antibioticCodeRaw: 'AMP', method: 'zone_diameter' }) as any).code);
  });
});

describe('applyMicroCode — record level', () => {
  it('ast record: code from the rule, other fields (organism/ast payload, barcode, value) untouched', () => {
    const r = base({ recordKind: 'ast', instrumentAnalyteCode: 'ignored-by-rule', ast: { antibioticCodeRaw: 'AMP', isolateSeq: 2, method: 'mic', rawValue: '<=2', interpretationRaw: 'S' } });
    const out = applyMicroCode(r);
    expect(out.instrumentAnalyteCode).toBe('AST:2:AMP:mic'); expect(out.ast).toEqual(r.ast); expect(out.sampleBarcode).toBe('E2600000042'); expect(out.warnings).toEqual([]);
  });
  it('ast record without isolateSeq defaults to isolate 1', () => {
    expect(applyMicroCode(base({ recordKind: 'ast', ast: { antibioticCodeRaw: 'CIP', method: 'zone_diameter', rawValue: '22' } })).instrumentAnalyteCode).toBe('AST:1:CIP:zone_diameter');
  });
  it('organism_id record: ORG:<seq|1>', () => {
    expect(applyMicroCode(base({ recordKind: 'organism_id', organism: { organismCodeRaw: 'ECOL', isolateSeq: 2 } })).instrumentAnalyteCode).toBe('ORG:2');
    expect(applyMicroCode(base({ recordKind: 'organism_id', organism: { organismCodeRaw: 'ECOL' } })).instrumentAnalyteCode).toBe('ORG:1');
  });
  it('over-64 composite: instrumentAnalyteCode is NOT set (never truncated) and the warning is appended once', () => {
    const out = applyMicroCode(base({ recordKind: 'ast', warnings: ['w0'], ast: { antibioticCodeRaw: 'A'.repeat(55), isolateSeq: 1, method: 'mic', rawValue: '1' } }));
    expect(out.instrumentAnalyteCode).toBeUndefined(); expect(out.warnings).toEqual(['w0', WARN]);
  });
  it('non-micro records (quantitative, qc, attachment) are returned unchanged', () => {
    for (const r of [base({ recordKind: 'quantitative', instrumentAnalyteCode: 'GLU' }), base({ recordClass: 'qc', recordKind: 'quantitative', instrumentAnalyteCode: 'GLU', controlIdRaw: 'QC1' }), base({ recordKind: 'attachment' })])
      expect(applyMicroCode(r)).toEqual(r);
  });
  it('does not mutate its input', () => {
    const r = base({ recordKind: 'ast', ast: { antibioticCodeRaw: 'AMP', method: 'mic', rawValue: '1' } }); const snap = structuredClone(r); applyMicroCode(r); expect(r).toEqual(snap);
  });
});
