// Rules engine: buildContent(inputs, library) -> SummaryContent (02-TRD §3, §4.1, §4.10; AC-08.2).
// Pure: no I/O, no clock, no mutation of inputs. Every input array is an id-keyed set; order is canonicalised here,
// so the same inputs give byte-identical canonical JSON and the same content_sha256.
import { createHash } from 'node:crypto';
import { type AdviceEntry, type AdviceTile, blockText, selectAdvice } from './advice.js';
import { type Band, type BandStatus, bandOf } from './band.js';
import { type DerangedBlock, type DerangedItem, type DerangedRule, type DerangedEntry, buildDerangedEntries } from './deranged.js';
import { type FollowUpRule, type FollowUpSuggestion, selectFollowUps } from './followups.js';
import { type Panel, type PanelGroup, buildPanels } from './groups.js';
import { type HealthScore, type ScoreParams, computeHealthScore } from './score.js';
import { type Trend, type TrendHistory, buildTrends } from './trends.js';

type Range = { low?: string; high?: string; text?: string };
type Language = 'en' | 'ne';

export interface EngineResult {
  resultId: string;
  analyteId: string;
  flag?: string;
  valueNumeric?: string;
  valueText?: string;
  ordinalCode?: string;
  unitCode?: string;
  approvedAt: string;
  referenceRangeSnapshot?: Range;
}
export interface EngineAnalyte { analyteId: string; name: string; printName?: string; sortOrder: number; resultType: string }
export interface EngineInputs {
  builtAt: string;
  results: readonly EngineResult[];
  analytes: readonly EngineAnalyte[];
  history?: TrendHistory;
  /** follow-up tests the caller already resolved ACTIVE */
  tests: readonly { testId: string; code: string; name: string }[];
}
export interface EngineBlock { id: string; kind: string; blockKey: string; textEn?: string; textNe?: string }
export interface EngineMapping { analyteId: string; groupCode: string; includeInScore: boolean; trendEnabled: boolean; borderlineFractionBp?: number }
export interface EngineGroup extends PanelGroup { scoreWeight: number }
export interface EngineLibrary {
  language: Language;
  disclaimerBlockId: string;
  params: ScoreParams & {
    adviceMaxBlocks: number; followupMax: number; trendMaxPoints: number; trendStableBp: number; trendsMax: number; borderlineFractionBp: number;
  };
  blocks: readonly EngineBlock[];
  rules: readonly (DerangedRule | FollowUpRule)[];
  mappings: readonly EngineMapping[];
  groups: readonly EngineGroup[];
}
export interface SummaryContent {
  language: Language;
  builtAt: string;
  healthScore?: HealthScore;
  panels: Panel[];
  deranged: DerangedEntry[];
  advice: { templateBlockId: string; text: string }[];
  followUps: FollowUpSuggestion[];
  trends: Trend[];
  disclaimerBlockId: string;
  disclaimerText: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortBy = <T>(xs: readonly T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => cmp(key(a), key(b)));
const MAPPED_TYPES = new Set(['numeric', 'ordinal', 'coded']);

/** Keys sorted (code-unit order) recursively, no whitespace, arrays keep order, undefined-valued keys omitted. Non-finite numbers throw. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': case 'boolean': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new RangeError('canonicalJson: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default: throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
  }
}

/** lower-case hex SHA-256 of the canonical JSON (UTF-8). */
export const contentSha256 = (content: unknown): string => createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');

export function buildContent(inputs: EngineInputs, library: EngineLibrary): SummaryContent {
  const { language, params } = library;
  const analytes = new Map(inputs.analytes.map((a) => [a.analyteId, a]));
  const mappings = new Map(library.mappings.map((m) => [m.analyteId, m]));
  const groups = new Map(library.groups.map((g) => [g.groupCode, g]));
  const groupName = (code: string): string => {
    const g = groups.get(code);
    return g === undefined ? code : language === 'ne' ? (g.displayNe || g.displayEn) : g.displayEn;
  };

  // §4.1 eligible results; per analyte the latest approvedAt wins, ties -> greatest resultId.
  const latest = new Map<string, EngineResult>();
  for (const r of sortBy(inputs.results, (x) => x.resultId)) {
    const an = analytes.get(r.analyteId);
    if (!mappings.has(r.analyteId) || an === undefined || !MAPPED_TYPES.has(an.resultType)) continue;
    const cur = latest.get(r.analyteId);
    if (cur === undefined || Date.parse(r.approvedAt) >= Date.parse(cur.approvedAt)) latest.set(r.analyteId, r); // resultId ascending: >= lets the greater id win ties
  }

  const eligible: { r: EngineResult; an: EngineAnalyte; m: EngineMapping; band: Band }[] = [];
  for (const r of latest.values()) {
    const m = mappings.get(r.analyteId)!;
    const band = bandOf({
      ...(r.flag !== undefined && { flag: r.flag }),
      ...(r.valueNumeric !== undefined && { valueNumeric: r.valueNumeric }),
      ...(r.referenceRangeSnapshot !== undefined && { referenceRangeSnapshot: r.referenceRangeSnapshot }),
      borderlineFractionBp: m.borderlineFractionBp ?? params.borderlineFractionBp,
    });
    if (band !== null) eligible.push({ r, an: analytes.get(r.analyteId)!, m, band });
  }

  const sortOf = (code: string) => groups.get(code)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const items: DerangedItem[] = eligible.map(({ r, an, m, band }) => ({
    resultId: r.resultId, analyteId: r.analyteId, groupCode: m.groupCode,
    groupSortOrder: sortOf(m.groupCode), analyteSortOrder: an.sortOrder,
    status: band.status as DerangedItem['status'],
    ...(band.direction !== undefined && { direction: band.direction }),
    analyte: { name: an.name, ...(an.printName !== undefined && { printName: an.printName }) },
    result: {
      ...(r.valueNumeric !== undefined && { valueNumeric: r.valueNumeric }),
      ...(r.valueText !== undefined && { valueText: r.valueText }),
      ...(r.ordinalCode !== undefined && { ordinalCode: r.ordinalCode }),
      ...(r.unitCode !== undefined && { unitCode: r.unitCode }),
    },
    ...(r.referenceRangeSnapshot !== undefined && { referenceRangeSnapshot: r.referenceRangeSnapshot }),
    groupName: groupName(m.groupCode),
  }));

  const blocks = sortBy(library.blocks, (b) => b.id);
  const rules = sortBy(library.rules, (r) => r.id);
  const panels = buildPanels({
    items: items.map((i) => ({ resultId: i.resultId, analyteId: i.analyteId, groupCode: i.groupCode, analyteSortOrder: i.analyteSortOrder, status: i.status as BandStatus })),
    groups: library.groups, language,
  });
  const deranged = buildDerangedEntries({ items, rules: rules as DerangedRule[], blocks: blocks as DerangedBlock[], language });
  const healthScore = computeHealthScore({
    members: eligible.map(({ m, band }) => ({ groupCode: m.groupCode, status: band.status, includeInScore: m.includeInScore })),
    groups: library.groups, params,
  });

  const groupOf = new Map(items.map((i) => [i.resultId, i.groupCode]));
  const entries: AdviceEntry[] = deranged.map((d) => ({
    resultId: d.resultId, analyteId: d.analyteId, direction: d.direction, severity: d.severity, analyteName: d.analyteName,
    groupCode: groupOf.get(d.resultId)!,
  }));
  const tiles: AdviceTile[] = panels.map((p) => ({ groupCode: p.panelCode, groupName: p.displayName, status: p.status }));
  const advice = selectAdvice({ entries, tiles, rules, blocks, language, adviceMaxBlocks: params.adviceMaxBlocks });
  const followUps = selectFollowUps({
    entries, tiles, rules: rules.filter((r): r is FollowUpRule => r.ruleKind === 'followup' && 'suggestedTestId' in r), blocks, language,
    followupMax: params.followupMax, tests: new Map(inputs.tests.map((t) => [t.testId, { code: t.code, name: t.name }])),
  });

  const severityOf = new Map(deranged.map((d) => [d.resultId, d.severity]));
  const trends = buildTrends({
    candidates: eligible.filter(({ r }) => r.valueNumeric !== undefined && r.referenceRangeSnapshot !== undefined).map(({ r, an, m }) => ({
      resultId: r.resultId, analyteId: r.analyteId, analyteName: an.printName ?? an.name, unitCode: r.unitCode ?? '',
      valueNumeric: r.valueNumeric!, approvedAt: r.approvedAt, trendEnabled: m.trendEnabled,
      referenceRangeSnapshot: { ...(r.referenceRangeSnapshot!.low !== undefined && { low: r.referenceRangeSnapshot!.low }), ...(r.referenceRangeSnapshot!.high !== undefined && { high: r.referenceRangeSnapshot!.high }) },
      ...(severityOf.has(r.resultId) && { derangedSeverity: severityOf.get(r.resultId)! }),
      groupSortOrder: sortOf(m.groupCode), analyteSortOrder: an.sortOrder,
    })),
    history: inputs.history,
    trendMaxPoints: params.trendMaxPoints, trendStableBp: params.trendStableBp, trendsMax: params.trendsMax,
  });

  return {
    language, builtAt: inputs.builtAt, ...(healthScore !== undefined && { healthScore }),
    panels, deranged, advice, followUps, trends,
    disclaimerBlockId: library.disclaimerBlockId,
    disclaimerText: blockText(blocks.find((b) => b.id === library.disclaimerBlockId), language, library.disclaimerBlockId),
  };
}
