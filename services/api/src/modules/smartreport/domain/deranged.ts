// Deranged entries + rule resolution (02-TRD §4.5; AC-10.1, AC-10.4).
import type { BandDirection } from './band.js';
import { type DerangedValueSource, derangedPlaceholderValues, fillPlaceholders } from './placeholders.js';

export type DerangedSeverity = 'borderline' | 'out_of_range' | 'critical';
const SEV_RANK: Readonly<Record<DerangedSeverity, number>> = { borderline: 0, out_of_range: 1, critical: 2 };
const SPECIFICITY = { analyte: 0, group: 1, any: 2 } as const;

export interface DerangedRule {
  id: string;
  ruleKind: string;
  triggerKind: 'analyte' | 'group' | 'any' | 'all_in_range';
  analyteId?: string;
  groupCode?: string;
  direction: BandDirection | 'any';
  minSeverity?: DerangedSeverity;
  priority: number;
  blockId: string;
}
export interface DerangedTarget { analyteId: string; groupCode: string; direction: BandDirection; severity: DerangedSeverity }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** analyte > group > any, then lowest priority, then smallest id. */
export function resolveDerangedRule(rules: readonly DerangedRule[], t: DerangedTarget): DerangedRule | undefined {
  const matches = rules.filter((r) =>
    r.ruleKind === 'deranged' &&
    (r.triggerKind === 'any' ||
      (r.triggerKind === 'analyte' && r.analyteId === t.analyteId) ||
      (r.triggerKind === 'group' && r.groupCode === t.groupCode)) &&
    (r.direction === 'any' || r.direction === t.direction) &&
    SEV_RANK[r.minSeverity ?? 'borderline'] <= SEV_RANK[t.severity]);
  return matches.sort((a, b) =>
    (SPECIFICITY[a.triggerKind as keyof typeof SPECIFICITY] - SPECIFICITY[b.triggerKind as keyof typeof SPECIFICITY]) ||
    a.priority - b.priority || cmp(a.id, b.id))[0];
}

export interface DerangedItem extends DerangedValueSource {
  resultId: string;
  analyteId: string;
  groupCode: string;
  groupSortOrder: number;
  analyteSortOrder: number;
  status: 'in_range' | DerangedSeverity;
  direction?: BandDirection;
}
export interface DerangedBlock { id: string; kind: string; textEn?: string; textNe?: string }
export interface DerangedEntry {
  resultId: string;
  analyteId: string;
  direction: BandDirection;
  severity: DerangedSeverity;
  templateBlockId: string;
  text: string;
  analyteName: string;
}

/** One entry per non-in_range item; order: severity desc, group sort, analyte sort, resultId. Throws if library is incomplete (V3 prevents). */
export function buildDerangedEntries(a: {
  items: readonly DerangedItem[];
  rules: readonly DerangedRule[];
  blocks: readonly DerangedBlock[];
  language: 'en' | 'ne';
}): DerangedEntry[] {
  const blocks = new Map(a.blocks.map((b) => [b.id, b]));
  return a.items
    .filter((i): i is DerangedItem & { status: DerangedSeverity } => i.status !== 'in_range')
    .sort((x, y) =>
      SEV_RANK[y.status] - SEV_RANK[x.status] || x.groupSortOrder - y.groupSortOrder ||
      x.analyteSortOrder - y.analyteSortOrder || cmp(x.resultId, y.resultId))
    .map((i) => {
      const direction = i.direction ?? 'abnormal'; // ponytail: band.ts always sets direction for non-in_range; fallback only for malformed input
      const rule = resolveDerangedRule(a.rules, { analyteId: i.analyteId, groupCode: i.groupCode, direction, severity: i.status });
      if (!rule) throw new Error(`no deranged rule for ${i.analyteId}/${direction}/${i.status}`);
      const block = blocks.get(rule.blockId);
      const template = a.language === 'ne' ? block?.textNe : block?.textEn;
      if (template === undefined) throw new Error(`block ${rule.blockId} has no ${a.language} text`);
      const values = derangedPlaceholderValues(i);
      return {
        resultId: i.resultId, analyteId: i.analyteId, direction, severity: i.status, templateBlockId: rule.blockId,
        text: fillPlaceholders(template, values), analyteName: values.analyte_name as string,
      };
    });
}
