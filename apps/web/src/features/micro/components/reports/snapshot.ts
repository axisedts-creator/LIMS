// Client-side preview of what the server snapshots on submit (02-TRD §4.6) and the generated summary text [CONV]. Pure: no state, no network, no styling (LD-140).
// The server builds the real snapshot and re-checks everything; this only shows the technologist what will be included and pre-fills the Summary.
import type { AstMethod, AstResultDto, CultureDetailDto, IsolateDto, ReportPhase } from '../../server/types';

export const SUMMARY_MAX = 4000;
export const NO_GROWTH = 'no_growth'; // culture_outcomes / growth_codes starter code (05-SCHEMA §3)

export interface IncludedIsolate { isolate: IsolateDto; rows: AstResultDto[] }

/** Identified, reportable, non-withdrawn isolates by sequence, each with its reportable, shown AST rows (TRD §4.6). */
export function includedIsolates(c: Pick<CultureDetailDto, 'isolates'>): IncludedIsolate[] {
  return c.isolates
    .filter((i) => i.status === 'identified' && i.is_reportable && !!i.organism_code)
    .sort((a, b) => a.isolate_seq - b.isolate_seq)
    .map((isolate) => ({ isolate, rows: (isolate.ast ?? []).filter((r) => r.is_reportable && r.report_visibility === 'shown').sort((a, b) => (a.panel_sort_order ?? 0) - (b.panel_sort_order ?? 0)) }));
}

/** Method unit shown next to a raw value (mic: mg/L, zone diameter: mm). */
export const unitOf = (m: AstMethod): string => (m === 'mic' ? 'mg/L' : m === 'zone_diameter' ? 'mm' : '');
export const withUnit = (raw: string | undefined, m: AstMethod) => (raw ? [raw, unitOf(m)].filter(Boolean).join(' ') : '—');

/** Line 1 "Final: {outcome}" / "Preliminary report"; Gram stain; one line per isolate; truncated to 4000 with "…". */
export function generateSummary(c: CultureDetailDto, phase: ReportPhase, outcomeDisplay: string | undefined): string {
  const lines: string[] = [phase === 'final' ? (outcomeDisplay ? `Final: ${outcomeDisplay}` : 'Final report') : 'Preliminary report'];
  const stains = c.observations.filter((o) => o.kind === 'gram_stain' && !o.is_corrected && o.finding_text).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  if (stains[0]) lines.push(`Gram stain: ${stains[0].finding_text}`);
  const iso = includedIsolates(c);
  for (const { isolate: i } of iso) lines.push(`Isolate ${i.isolate_seq}: ${i.organism_display ?? i.organism_code}${i.quantity_text ? ` — ${i.quantity_text}` : ''}`);
  if (phase === 'preliminary' && iso.length === 0) {
    const read = c.observations.filter((o) => o.kind === 'plate_read' && !o.is_corrected).sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))[0];
    if (read?.growth_code === NO_GROWTH && read.hours_since_planting !== undefined) lines.push(`No growth after ${Math.floor(read.hours_since_planting)} h`);
  }
  const text = lines.join('\n');
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/** The early-final reason field shows for a "no growth" final before the final-due time (AC-10.3). */
export const isEarlyFinal = (c: Pick<CultureDetailDto, 'final_due_at'>, phase: ReportPhase, outcome: string | undefined, now = Date.now()) =>
  phase === 'final' && outcome === NO_GROWTH && !!c.final_due_at && now < Date.parse(c.final_due_at);

/** C5 has an approved line and the user cannot submit a change to it (08 A17 D-61): the drawer explains why the submit is disabled. */
export const approvedBlocked = (c: Pick<CultureDetailDto, 'lab_result' | 'permissions_hint'>) => c.lab_result?.status === 'approved' && !c.permissions_hint?.can_amend_approved;
export const blockedText = (phase: ReportPhase) =>
  phase === 'final' ? 'The preliminary report is already approved. A pathologist must submit the final.' : 'The preliminary report is already approved. A pathologist must submit an updated preliminary.';
