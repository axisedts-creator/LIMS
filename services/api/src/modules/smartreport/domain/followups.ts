// Suggested follow-up tests (02-TRD §4.7; AC-12.1 shape, AC-12.3 dedupe smallest interval; no follow-up without a finding — AB-3, AC-05.3).
import { type AdviceBlock, type AdviceEntry, type AdviceRule, type AdviceTile, type RuleMatch, blockText, matchRules, matchValues } from './advice.js';
import { fillPlaceholders } from './placeholders.js';

const RANK = { in_range: -1, borderline: 0, out_of_range: 1, critical: 2 } as const;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type FollowUpRule = AdviceRule & { suggestedTestId: string; intervalDays: number };
export interface FollowUpSuggestion { ruleId: string; suggestedTestCode: string; suggestedTestName: string; intervalDays: number; text: string }

/** `tests` = tests the caller resolved as ACTIVE; rules pointing elsewhere are skipped before dedupe and cap. */
export function selectFollowUps(a: {
  entries: readonly AdviceEntry[];
  tiles: readonly AdviceTile[];
  rules: readonly FollowUpRule[];
  blocks: readonly AdviceBlock[];
  language: 'en' | 'ne';
  followupMax: number;
  tests: ReadonlyMap<string, { code: string; name: string }>;
}): FollowUpSuggestion[] {
  if (a.entries.length === 0) return []; // no finding, no follow-up
  const blocks = new Map(a.blocks.map((b) => [b.id, b]));
  const live = a.rules.filter((r) => r.triggerKind !== 'all_in_range' && a.tests.has(r.suggestedTestId));
  const better = (x: RuleMatch & { rule: FollowUpRule }, y: RuleMatch & { rule: FollowUpRule }) =>
    x.rule.intervalDays - y.rule.intervalDays || x.rule.priority - y.rule.priority || cmp(x.rule.id, y.rule.id);
  const byTest = new Map<string, RuleMatch & { rule: FollowUpRule }>();
  for (const m of matchRules('followup', live, a.entries, a.tiles) as (RuleMatch & { rule: FollowUpRule })[]) {
    const cur = byTest.get(m.rule.suggestedTestId);
    if (!cur || better(m, cur) < 0) byTest.set(m.rule.suggestedTestId, m);
  }
  return [...byTest.values()]
    .sort((x, y) =>
      RANK[y.severity] - RANK[x.severity] || x.rule.intervalDays - y.rule.intervalDays ||
      x.rule.priority - y.rule.priority || cmp(x.rule.id, y.rule.id))
    .slice(0, Math.max(0, a.followupMax))
    .map((m) => {
      const test = a.tests.get(m.rule.suggestedTestId)!;
      const values = { ...matchValues(m), test_name: test.name, interval_days: String(m.rule.intervalDays) };
      return {
        ruleId: m.rule.id,
        suggestedTestCode: test.code,
        suggestedTestName: test.name,
        intervalDays: m.rule.intervalDays,
        text: fillPlaceholders(blockText(blocks.get(m.rule.blockId), a.language, m.rule.blockId), values),
      };
    });
}
