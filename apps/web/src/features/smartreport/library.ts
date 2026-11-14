// SR-03 / SR-04 shared shapes, labels and client checks (04-UI-UX SR-03/SR-04). The checks mirror the server (library.validate.ts); the server repeats them.
export type Status = 'draft' | 'in_review' | 'approved' | 'retired';
export type Lang = 'en' | 'ne';
export type BlockKind = 'deranged' | 'advice' | 'followup' | 'disclaimer' | 'score_explanation';
export type RuleKind = 'deranged' | 'advice' | 'followup';

export interface Summary { id: string; version_no: number; status: Status; language: Lang; approved_by_display_name?: string; approved_at?: string; updated_at?: string; version: number }
export type Params = Record<string, number | boolean>;
export interface Version { id: string; version_no: number; status: Status; language: Lang; formula_version?: string; params: Params; change_summary?: string; version: number }
export interface Block { id: string; block_key: string; kind: BlockKind; text_en?: string; text_ne?: string; note?: string; version: number }
export interface Rule {
  id: string; rule_kind: RuleKind; trigger_kind: 'analyte' | 'group' | 'any' | 'all_in_range'; analyte_id?: string; group_code?: string; direction: string; min_severity?: string;
  priority?: number; block_id: string; suggested_test_id?: string; interval_days?: number; version: number;
}
export interface Mapping { analyte_id: string; group_code: string; include_in_score?: boolean; trend_enabled?: boolean; borderline_fraction_bp?: number; trend_stable_bp?: number; sort_order?: number; version: number; analyte_name?: string; test_name?: string }
export interface Group { group_code: string; display_en: string; display_ne?: string; score_weight: number; sort_order: number; is_shown: boolean; version: number }
export interface Option { value: string; label: string }
export interface Issue { code: string; severity: string; detail?: string; block_key?: string; rule_id?: string; path?: string }

export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved', retired: 'Retired' };
export const LANG_LABEL: Record<string, string> = { en: 'English', ne: 'Nepali' };
export const KIND_LABEL: Record<BlockKind, string> = { deranged: 'Findings', advice: 'Advice', followup: 'Follow-up', disclaimer: 'Disclaimer', score_explanation: 'Score explanation' };
export const KINDS = Object.keys(KIND_LABEL) as BlockKind[];

/** Same table as services/api/.../domain/placeholders.ts ALLOWED_PLACEHOLDERS (the server is the authority). */
export const ALLOWED_PLACEHOLDERS: Record<BlockKind, readonly string[]> = {
  deranged: ['analyte_name', 'value', 'unit', 'ref_range', 'group_name'],
  advice: ['analyte_name', 'group_name'],
  followup: ['test_name', 'interval_days', 'group_name', 'analyte_name'],
  disclaimer: [],
  score_explanation: [],
};

export const FOLLOWUP_BANNER = 'Follow-up suggestions are shown to patients. Keep them conservative; they must be justified by a finding. Prices and booking links are never shown.';
export const NOT_DRAFT = 'This version is no longer a draft.';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BLOCK_KEY_RE = /^[a-z][a-z0-9_.]{2,79}$/;
export const TEXT_MAX = 600;

const DIGIT = /[0-9०-९]/;
const EMAIL = /\S+@\S+\.\S+/;

/** Content checks of one block text (digits, links, placeholders, length). Returns the messages, empty when clean. */
export function textProblems(text: string, kind: BlockKind | undefined, label: string): string[] {
  const out: string[] = [];
  if (text.length > TEXT_MAX) out.push(`${label} must be ${TEXT_MAX} characters or fewer.`);
  if (DIGIT.test(text)) out.push('Numbers (digits) are not allowed; use a placeholder such as {value}.');
  const low = text.toLowerCase();
  if (low.includes('http') || low.includes('www.') || EMAIL.test(text)) out.push('Links, web addresses and e-mail addresses are not allowed.');
  const allowed = kind ? ALLOWED_PLACEHOLDERS[kind] : [];
  for (const m of new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((x) => x[1]!))) {
    if (!allowed.includes(m)) out.push(`Placeholder {${m}} is not allowed for this kind.`);
  }
  return out;
}

// ---- SR-05 review: "Changes since active version" (04-UI-UX SR-05). Identity: blocks by block_key; rules by (rule_kind, trigger_kind, analyte|group, direction, block_key); mappings by analyte_id.
export interface Counts { added: number; changed: number; removed: number }
export interface Diff { texts: Counts; rules: Counts; mapping: Counts }

function countDiff<T>(base: T[], next: T[], id: (x: T) => string, same: (a: T, b: T) => boolean): Counts {
  const old = new Map(base.map((x) => [id(x), x]));
  const seen = new Set<string>();
  let added = 0, changed = 0;
  for (const x of next) {
    const k = id(x);
    seen.add(k);
    const o = old.get(k);
    if (!o) added++; else if (!same(o, x)) changed++;
  }
  return { added, changed, removed: [...old.keys()].filter((k) => !seen.has(k)).length };
}
const pick = <T extends object>(o: T, keys: readonly string[]) => JSON.stringify(keys.map((k) => (o as Record<string, unknown>)[k] ?? null));

export function diffLibrary(base: { blocks: Block[]; rules: Rule[]; mappings: Mapping[] }, next: { blocks: Block[]; rules: Rule[]; mappings: Mapping[] }): Diff {
  const key = (blocks: Block[]) => new Map(blocks.map((b) => [b.id, b.block_key]));
  const bk = { base: key(base.blocks), next: key(next.blocks) };
  const ruleId = (m: Map<string, string>) => (r: Rule) => JSON.stringify([r.rule_kind, r.trigger_kind, r.analyte_id ?? r.group_code ?? null, r.direction, m.get(r.block_id) ?? r.block_id]);
  // one id function per side: block ids differ between versions, block keys do not
  const baseRules = new Map(base.rules.map((r) => [ruleId(bk.base)(r), r]));
  const nextRules = new Map(next.rules.map((r) => [ruleId(bk.next)(r), r]));
  const RULE_FIELDS = ['min_severity', 'priority', 'suggested_test_id', 'interval_days'];
  const rules: Counts = { added: 0, changed: 0, removed: 0 };
  for (const [k, r] of nextRules) { const o = baseRules.get(k); if (!o) rules.added++; else if (pick(o, RULE_FIELDS) !== pick(r, RULE_FIELDS)) rules.changed++; }
  for (const k of baseRules.keys()) if (!nextRules.has(k)) rules.removed++;
  const MAP_FIELDS = ['group_code', 'include_in_score', 'trend_enabled', 'borderline_fraction_bp', 'trend_stable_bp', 'sort_order'];
  return {
    texts: countDiff(base.blocks, next.blocks, (b) => b.block_key, (a, b) => pick(a, ['kind', 'text_en', 'text_ne']) === pick(b, ['kind', 'text_en', 'text_ne'])),
    rules,
    mapping: countDiff(base.mappings, next.mappings, (m) => m.analyte_id, (a, b) => pick(a, MAP_FIELDS) === pick(b, MAP_FIELDS)),
  };
}

// ---- SR-06 wording terms, preview (SR-04 "Check & submit")
export interface Term { id?: string; term: string; language: 'en' | 'ne' | 'any'; scope: 'global' | 'tenant'; reason?: string; is_active: boolean; version?: number }
export const TERM_LANG_LABEL: Record<string, string> = { en: 'English', ne: 'Nepali', any: 'Any' };
export const FIXTURES = ['synthetic_basic', 'synthetic_all_in_range', 'synthetic_critical'] as const;
export type Fixture = (typeof FIXTURES)[number];
/** Only the fields the preview dialog renders cross to the browser. */
export interface Preview {
  score?: { value: number; band: string; explanation?: string };
  panels: { name: string; status: string }[];
  deranged: string[]; advice: string[]; followUps: string[]; disclaimer?: string;
}

export const statusText =(s: string) => (STATUS_LABEL[s] ?? s.replace(/_/g, ' ')).toLowerCase();
export const newKey = () => globalThis.crypto.randomUUID();
