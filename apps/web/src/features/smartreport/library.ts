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

export const statusText = (s: string) => (STATUS_LABEL[s] ?? s.replace(/_/g, ' ')).toLowerCase();
export const newKey = () => globalThis.crypto.randomUUID();
