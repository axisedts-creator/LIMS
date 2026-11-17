// Version kind (02-TRD §4.5 = 08 R1 rules 1-4 + rule 0 D-33 + exclusion set D-61; AC-02.6, AC-02.8). Pure. First match wins.
export type ReportKind = 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum';

export const EXCLUDED_AMENDMENT_REASONS: ReadonlySet<string> = new Set(['module_phase_progression', 'module_preliminary_update', 'supplementary_report']);

export interface KindSection {
  kind: string; // 'lab' | 'narrative' | 'micro' | 'anatomic' | ...
  phase?: 'preliminary' | 'final';
  amendmentReason?: string; // latest amendment reason of the section, absent when unamended
}

export interface KindInput {
  regeneration?: { reasonCode: string };
  earlierReleased: boolean;
  sections: readonly KindSection[];
  complete: boolean;
}

export function versionKind(i: KindInput): ReportKind {
  if (i.regeneration && i.earlierReleased && i.regeneration.reasonCode !== 'smart_summary_added') return 'amended';
  if (i.earlierReleased && i.sections.some((s) => s.amendmentReason !== undefined && (s.kind === 'narrative' || !EXCLUDED_AMENDMENT_REASONS.has(s.amendmentReason)))) return 'amended';
  if (i.sections.some((s) => s.amendmentReason === 'supplementary_report')) return 'addendum';
  if (i.sections.some((s) => s.kind === 'micro' && s.phase === 'preliminary')) return 'preliminary';
  return i.complete ? 'final' : 'partial';
}

/** Rule 0 amendment-box entry; the caller adds previousVersionNo / amendedAt. */
export function regenerationNote(reasonCode: string, reasonText?: string): { analyteOrSection: string; reasonCode: string; reasonText?: string } {
  return { analyteOrSection: 'Report details', reasonCode, ...(reasonText !== undefined ? { reasonText } : {}) };
}
