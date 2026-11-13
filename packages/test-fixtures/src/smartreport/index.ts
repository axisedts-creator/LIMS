// Smart Report preview fixtures (C14 T16, AC-19.1). LD-135 (2026-11-12): CR-C14-T16a approved with SYNTHETIC, NON-clinical data (REQ-SEC 136).
// Not re-exported from ../index.ts on purpose: package exports and version stay unchanged; consumers import this file by path.
// Shapes mirror services/api/src/modules/smartreport/domain/engine.ts (EngineResult / EngineAnalyte, camelCase).
// The C5 flag is the band authority (domain/band.ts): 'L' = out of range, 'LL' = critical, 'N' = in range. Values sit mid-window so no borderline band can trigger.

export interface FixtureEngineResult {
  resultId: string;
  analyteId: string;
  flag?: string;
  valueNumeric?: string;
  unitCode?: string;
  approvedAt: string;
  referenceRangeSnapshot?: { low?: string; high?: string };
}
export interface FixtureEngineAnalyte { analyteId: string; name: string; sortOrder: number; resultType: string }
export interface SmartPreviewFixture { results: FixtureEngineResult[]; analytes: FixtureEngineAnalyte[] }
export type SmartPreviewFixtureCode = 'synthetic_basic' | 'synthetic_all_in_range' | 'synthetic_critical';

const APPROVED_AT = '2026-01-01T00:00:00.000Z';
const ANALYTE_ID = (n: number): string => `01a1a98a-ac40-7000-8000-5ffa0000000${n}`;
const RESULT_ID = (n: number): string => `01a1a98a-ac40-7000-8000-5ffb0000000${n}`;

const ANALYTES: FixtureEngineAnalyte[] = [1, 2, 3].map((n) => ({ analyteId: ANALYTE_ID(n), name: `Synthetic analyte ${n}`, sortOrder: n * 10, resultType: 'numeric' }));
// Plain artificial window 10..20 (critical below 5), unit 'u'.
const row = (n: number, flag: string, value: string): FixtureEngineResult => ({
  resultId: RESULT_ID(n), analyteId: ANALYTE_ID(n), flag, valueNumeric: value, unitCode: 'u', approvedAt: APPROVED_AT, referenceRangeSnapshot: { low: '10', high: '20' },
});
const fixture = (flags: [string, string][]): SmartPreviewFixture => ({ analytes: ANALYTES.map((a) => ({ ...a })), results: flags.map(([f, v], i) => row(i + 1, f, v)) });

export const SMART_PREVIEW_FIXTURES: Record<SmartPreviewFixtureCode, SmartPreviewFixture> = {
  synthetic_basic: fixture([['L', '8'], ['N', '15'], ['N', '15']]),
  synthetic_all_in_range: fixture([['N', '15'], ['N', '15'], ['N', '15']]),
  synthetic_critical: fixture([['LL', '3'], ['N', '15'], ['N', '15']]),
};
