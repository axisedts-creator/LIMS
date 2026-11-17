// Advice selection (02-TRD §4.6; AC-11.1 dedupe, AC-11.2 cap, AC-11.3 all_in_range). Also hosts the rule matcher reused by followups.ts (§4.7).
import type { BandDirection } from './band.js';
import type { DerangedEntry, DerangedRule, DerangedSeverity } from './deranged.js';
import { fillPlaceholders } from './placeholders.js';

export type TileStatus = 'in_range' | DerangedSeverity;
const RANK: Readonly<Record<TileStatus, number>> = { in_range: -1, borderline: 0, out_of_range: 1, critical: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type AdviceEntry = Pick<DerangedEntry, 'resultId' | 'analyteId' | 'direction' | 'severity' | 'analyteName'> & { groupCode: string };
export interface AdviceTile { groupCode: string; groupName: string; status: TileStatus }
export type AdviceRule = DerangedRule;
export interface AdviceBlock { id: string; kind: string; blockKey: string; textEn?: string; textNe?: string }

export interface RuleMatch {
  rule: AdviceRule;
  severity: TileStatus; // trigger severity
  entry?: AdviceEntry | undefined; // most severe matching entry (absent for all_in_range)
  groupName?: string | undefined;
}

const dirOk = (r: AdviceRule, d: BandDirection) => r.direction === 'any' || r.direction === d;
const minRank = (r: AdviceRule) => RANK[r.minSeverity ?? 'borderline'];

/** Matches rules of `kind` against entries/tiles (§4.6). Entries beyond the first of equal severity lose ties by input order. */
export function matchRules(kind: string, rules: readonly AdviceRule[], entries: readonly AdviceEntry[], tiles: readonly AdviceTile[]): RuleMatch[] {
  const best = (xs: readonly AdviceEntry[]) => xs.reduce<AdviceEntry | undefined>((b, e) => (!b || RANK[e.severity] > RANK[b.severity] ? e : b), undefined);
  const groupName = (code?: string) => tiles.find((t) => t.groupCode === code)?.groupName;
  const out: RuleMatch[] = [];
  for (const rule of rules) {
    if (rule.ruleKind !== kind) continue;
    if (rule.triggerKind === 'all_in_range') {
      if (entries.length === 0) out.push({ rule, severity: 'in_range' });
      continue;
    }
    const sat = (e: AdviceEntry) => dirOk(rule, e.direction) && RANK[e.severity] >= minRank(rule);
    if (rule.triggerKind === 'group') {
      const tile = tiles.find((t) => t.groupCode === rule.groupCode);
      if (!tile || RANK[tile.status] < minRank(rule)) continue;
      const inGroup = entries.filter((e) => e.groupCode === rule.groupCode && dirOk(rule, e.direction));
      if (rule.direction !== 'any' && inGroup.length === 0) continue;
      out.push({ rule, severity: rule.direction === 'any' ? tile.status : best(inGroup)!.severity, entry: best(inGroup), groupName: tile.groupName });
      continue;
    }
    const hit = best(entries.filter((e) => sat(e) && (rule.triggerKind === 'any' || e.analyteId === rule.analyteId)));
    if (hit) out.push({ rule, severity: hit.severity, entry: hit, groupName: groupName(hit.groupCode) });
  }
  return out;
}

/** Placeholder values available from a match (analyte_name, group_name); missing ones make fillPlaceholders throw. */
export function matchValues(m: RuleMatch): Record<string, string> {
  const v: Record<string, string> = {};
  if (m.entry) v.analyte_name = m.entry.analyteName;
  if (m.groupName !== undefined) v.group_name = m.groupName;
  return v;
}

export function blockText(b: AdviceBlock | undefined, language: 'en' | 'ne', blockId: string): string {
  const t = language === 'ne' ? b?.textNe : b?.textEn;
  if (t === undefined) throw new Error(`block ${blockId} has no ${language} text`);
  return t;
}

/** Dedupe by block (highest severity, then lowest priority); order severity desc, priority asc, block_key asc; cap. */
export function selectAdvice(a: {
  entries: readonly AdviceEntry[];
  tiles: readonly AdviceTile[];
  rules: readonly AdviceRule[];
  blocks: readonly AdviceBlock[];
  language: 'en' | 'ne';
  adviceMaxBlocks: number;
}): { templateBlockId: string; text: string }[] {
  const blocks = new Map(a.blocks.map((b) => [b.id, b]));
  const better = (x: RuleMatch, y: RuleMatch) =>
    RANK[x.severity] - RANK[y.severity] || y.rule.priority - x.rule.priority || cmp(y.rule.id, x.rule.id);
  const byBlock = new Map<string, RuleMatch>();
  for (const m of matchRules('advice', a.rules, a.entries, a.tiles)) {
    const cur = byBlock.get(m.rule.blockId);
    if (!cur || better(m, cur) > 0) byBlock.set(m.rule.blockId, m);
  }
  const key = (id: string) => blocks.get(id)?.blockKey ?? id;
  return [...byBlock.values()]
    .sort((x, y) =>
      RANK[y.severity] - RANK[x.severity] || x.rule.priority - y.rule.priority ||
      cmp(key(x.rule.blockId), key(y.rule.blockId)) || cmp(x.rule.blockId, y.rule.blockId))
    .slice(0, Math.max(0, a.adviceMaxBlocks))
    .map((m) => ({
      templateBlockId: m.rule.blockId,
      text: fillPlaceholders(blockText(blocks.get(m.rule.blockId), a.language, m.rule.blockId), matchValues(m)),
    }));
}
