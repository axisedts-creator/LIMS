// Breakpoint suggestion (02-TRD §4.5). Pure: no clock, no IO, exact decimals (scaled BigInt, never IEEE floats).
// `disabled` (settings / feature flags) is a service concern and is not decided here.
import type { AstValue } from './ast-value.js';
import { parseDecimal } from './decimal.js';

export interface BpSet { id: string; standard: string; standard_version: string; status: string; effective_from: Date; effective_to: Date | null }
export interface BpRow {
  id: string; set_id: string; organism_scope: 'organism' | 'group' | 'any'; organism_code: string | null;
  antibiotic_code: string; method: string; specimen_site_code: string | null; qualifier_code: string | null;
}
export interface BpBand {
  id: string; row_id: string; category_code: string;
  lower_value: string | null; lower_inclusive: boolean; upper_value: string | null; upper_inclusive: boolean;
}
export interface BreakpointRequest {
  antibiotic_code: string; method: 'mic' | 'zone_diameter' | 'other'; qualifier_code?: string | null; parsed: AstValue;
  organism_code: string; organism_group_code: string | null; specimen_site_code: string | null;
}
export interface BreakpointInput { now: Date; standard: string; sets: readonly BpSet[]; rows: readonly BpRow[]; bands: readonly BpBand[]; request: BreakpointRequest }
export type BreakpointNoneReason = 'no_active_set' | 'no_row' | 'indeterminate' | 'value_invalid';
export type BreakpointResult =
  | { suggestion: { category_code: string; standard: string; standard_version: string; breakpoint_set_id: string; breakpoint_band_id: string } }
  | { suggestion: 'none'; reason: BreakpointNoneReason };

const none = (reason: BreakpointNoneReason): BreakpointResult => ({ suggestion: 'none', reason });

// Interval of the true value; hi === null means +infinity. lo is always finite (>= 0).
interface Interval { lo: bigint; loIncl: boolean; hi: bigint | null; hiIncl: boolean }

function valueInterval(p: AstValue): Interval | null {
  if (p.raw_numeric === undefined) return null;
  const v = parseDecimal(p.raw_numeric);
  switch (p.raw_qualifier ?? '=') {
    case '=': return { lo: v, loIncl: true, hi: v, hiIncl: true };
    case '<=': return { lo: 0n, loIncl: true, hi: v, hiIncl: true };
    case '<': return { lo: 0n, loIncl: true, hi: v, hiIncl: false };
    case '>=': return { lo: v, loIncl: true, hi: null, hiIncl: false };
    case '>': return { lo: v, loIncl: false, hi: null, hiIncl: false };
    default: return null;
  }
}

function bandContains(b: BpBand, v: Interval): boolean {
  if (b.lower_value !== null) {
    const bl = parseDecimal(b.lower_value);
    if (v.lo < bl) return false;
    if (v.lo === bl && !b.lower_inclusive && v.loIncl) return false;
  }
  if (b.upper_value !== null) {
    if (v.hi === null) return false;
    const bu = parseDecimal(b.upper_value);
    if (v.hi > bu) return false;
    if (v.hi === bu && !b.upper_inclusive && v.hiIncl) return false;
  }
  return true;
}

const byIdAsc = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function pickSet(i: BreakpointInput): BpSet | null {
  const t = i.now.getTime();
  const ok = i.sets.filter((s) => s.standard === i.standard && (s.status === 'active' || s.status === 'retired')
    && s.effective_from.getTime() <= t && (s.effective_to === null || t < s.effective_to.getTime()));
  // Deterministic if data overlaps: latest effective_from, then lowest id.
  ok.sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime() || byIdAsc(a, b));
  return ok[0] ?? null;
}

function pickRow(rows: readonly BpRow[], set: BpSet, r: BreakpointRequest): BpRow | null {
  const qual = r.qualifier_code ?? null;
  let best: { row: BpRow; rank: number; site: number } | null = null;
  for (const row of rows) {
    if (row.set_id !== set.id || row.antibiotic_code !== r.antibiotic_code || row.method !== r.method) continue;
    if ((row.qualifier_code ?? null) !== qual) continue;
    let rank: number;
    if (row.organism_scope === 'organism') { if (row.organism_code !== r.organism_code) continue; rank = 3; }
    else if (row.organism_scope === 'group') { if (r.organism_group_code === null || row.organism_code !== r.organism_group_code) continue; rank = 2; }
    else rank = 1;
    let site = 0;
    if (row.specimen_site_code !== null) { if (r.specimen_site_code === null || row.specimen_site_code !== r.specimen_site_code) continue; site = 1; }
    if (!best || rank > best.rank || (rank === best.rank && (site > best.site || (site === best.site && byIdAsc(row, best.row) < 0)))) best = { row, rank, site };
  }
  return best?.row ?? null;
}

export function evaluateBreakpoint(i: BreakpointInput): BreakpointResult {
  const interval = i.request.method === 'other' ? null : valueInterval(i.request.parsed);
  if (!interval) return none('value_invalid');
  const set = pickSet(i);
  if (!set) return none('no_active_set');
  const row = pickRow(i.rows, set, i.request);
  if (!row) return none('no_row');
  // The most specific row decides; a gap there is not papered over by a less specific row.
  const hits = i.bands.filter((b) => b.row_id === row.id && bandContains(b, interval));
  const hit = hits.length === 1 ? hits[0] : undefined; // 0 = gap/spanning; >1 = ambiguous data -> fail closed
  if (!hit) return none('indeterminate');
  return { suggestion: { category_code: hit.category_code, standard: i.standard, standard_version: set.standard_version, breakpoint_set_id: set.id, breakpoint_band_id: hit.id } };
}
