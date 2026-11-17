// Library validation V1-V14 (02-TRD §9.4; §4.9 placeholders; §9.5 deny terms; 08 A19 D-108). Pure: no I/O, never mutates its arguments, collects every issue.
// V6 (catalog) and V13 (catalog analyte status) are fed in through `env`; the service looks them up.
import { type BlockKind, ALLOWED_PLACEHOLDERS, extractPlaceholders } from './placeholders.js';
import { denyTermHits, normaliseForMatch } from './wording.js';

export type Language = 'en' | 'ne';
export interface LibBlock { id: string; blockKey: string; kind: BlockKind; textEn?: string | null; textNe?: string | null }
export interface LibRule {
  id: string; ruleKind: BlockKind; triggerKind: 'analyte' | 'group' | 'any' | 'all_in_range'; analyteId?: string; groupCode?: string;
  direction: 'low' | 'high' | 'abnormal' | 'any'; minSeverity?: 'borderline' | 'out_of_range' | 'critical'; priority: number; blockId: string; blockKind: BlockKind;
  suggestedTestId?: string; intervalDays?: number;
}
export interface LibMapping { id: string; analyteId: string; groupCode: string }
export interface LibraryInput { language: Language; scoreEnabled: boolean; blocks: readonly LibBlock[]; rules: readonly LibRule[]; mappings: readonly LibMapping[] }
export interface ValidationEnv {
  denyTerms: readonly { term: string }[];
  inactiveTestIds: ReadonlySet<string>;
  inactiveAnalyteIds: ReadonlySet<string>;
}
export interface Issue {
  code: string; severity: 'error' | 'warning'; path: string;
  blockKey?: string; term?: string; direction?: string; placeholder?: string;
}
export interface ValidationReport { valid: boolean; errors: Issue[]; warnings: Issue[] }

export const LIMITS = { blocks: 500, rules: 1000, mappings: 2000 } as const; // V11 [CONV]

const DIGIT = /[0-9०-९]/;
const DEVANAGARI = /[ऀ-ॿ]/;
const PHONE = /\+?[0-9०-९][0-9०-९ -]{6,}/;

/** V8 without a backtracking regex: `\S+@\S+` = a whitespace-free token with an "@" that is neither first nor last. Linear in the text. */
function hasEmailShape(text: string): boolean {
  for (const tok of text.split(/\s+/)) {
    for (let i = tok.indexOf('@'); i !== -1; i = tok.indexOf('@', i + 1)) if (i > 0 && i < tok.length - 1) return true;
  }
  return false;
}
const hasContactOrLink = (text: string): boolean => {
  const t = normaliseForMatch(text);
  return t.includes('http') || t.includes('www.') || hasEmailShape(t) || PHONE.test(t);
};

const blank = (t: string | null | undefined): boolean => t == null || t.trim() === '';

/** Can `name` be filled for a rule with this trigger? (§4.9: analyte_name needs an analyte-bearing match, group_name any non-all_in_range match.) */
function resolvable(kind: BlockKind, name: string, r: LibRule): boolean {
  if (kind === 'advice' || kind === 'followup') {
    if (name === 'analyte_name') return r.triggerKind === 'analyte' || r.triggerKind === 'any';
    if (name === 'group_name') return r.triggerKind !== 'all_in_range';
  }
  return true; // test_name / interval_days come from the rule; deranged values come from the result
}

export function validateLibrary(lib: LibraryInput, env: ValidationEnv): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: string, path: string, extra: Partial<Issue> = {}) => errors.push({ code, severity: 'error', path, ...extra });
  const warn = (code: string, path: string, extra: Partial<Issue> = {}) => warnings.push({ code, severity: 'warning', path, ...extra });
  const texts = (b: LibBlock): string[] => [b.textEn, b.textNe].filter((t): t is string => typeof t === 'string');
  const langText = (b: LibBlock) => (lib.language === 'ne' ? b.textNe : b.textEn);
  const bp = (b: LibBlock) => `/blocks/${b.id}`;

  // V11 size limits (first, so an absurd library is flagged even if the rest is slow)
  for (const k of ['blocks', 'rules', 'mappings'] as const) if (lib[k].length > LIMITS[k]) err('library_too_large', `/${k}`);

  const blockById = new Map(lib.blocks.map((b) => [b.id, b]));
  const rulesByBlock = new Map<string, LibRule[]>();
  for (const r of lib.rules) rulesByBlock.set(r.blockId, [...(rulesByBlock.get(r.blockId) ?? []), r]);

  // V1 disclaimer
  const disclaimers = lib.blocks.filter((b) => b.kind === 'disclaimer');
  if (disclaimers.length > 1) err('disclaimer_duplicate', '/blocks');
  else if (disclaimers.length === 0 || blank(langText(disclaimers[0]!))) err('disclaimer_missing', disclaimers[0] ? bp(disclaimers[0]) : '/blocks');

  // V2 score explanation (exactly one; the TRD names only the _missing code, used for "none" and "more than one")
  if (lib.scoreEnabled && lib.blocks.filter((b) => b.kind === 'score_explanation').length !== 1) err('score_explanation_missing', '/blocks');

  // V3 generic deranged rules at borderline for low, high, abnormal
  for (const direction of ['low', 'high', 'abnormal'] as const) {
    const covered = lib.rules.some((r) => r.ruleKind === 'deranged' && r.triggerKind === 'any' && (r.minSeverity ?? 'borderline') === 'borderline' && (r.direction === direction || r.direction === 'any'));
    if (!covered) err('generic_deranged_missing', '/rules', { direction });
  }

  for (const b of lib.blocks) {
    // V4 placeholders: unknown for the kind, then unresolvable for every rule trigger that uses the block
    const names = [...new Set(texts(b).flatMap(extractPlaceholders))];
    const allowed = ALLOWED_PLACEHOLDERS[b.kind] ?? [];
    for (const placeholder of names) {
      if (!allowed.includes(placeholder)) err('placeholder_unknown', bp(b), { blockKey: b.blockKey, placeholder });
      else if ((rulesByBlock.get(b.id) ?? []).some((r) => !resolvable(b.kind, placeholder, r))) err('placeholder_unresolvable', bp(b), { blockKey: b.blockKey, placeholder });
    }
    // V5 digits, V8 links/contact: once per block, every text
    if (texts(b).some((t) => DIGIT.test(t))) err('digits_not_allowed', bp(b), { blockKey: b.blockKey });
    if (texts(b).some(hasContactOrLink)) err('contact_or_link_not_allowed', bp(b), { blockKey: b.blockKey });
    // V7 deny terms: every text of every block
    for (const term of new Set(texts(b).flatMap((t) => denyTermHits(t, env.denyTerms)))) err('deny_term', bp(b), { blockKey: b.blockKey, term });
  }

  // V6 follow-up tests (env.inactiveTestIds = tests the catalog says are inactive or not visible)
  for (const r of lib.rules) if (r.suggestedTestId !== undefined && env.inactiveTestIds.has(r.suggestedTestId)) err('followup_test_inactive', `/rules/${r.id}`);

  // V9 language, used blocks only (referenced by a rule, plus the disclaimer / score explanation the engine always uses)
  for (const b of lib.blocks) {
    const used = rulesByBlock.has(b.id) || b.kind === 'disclaimer' || b.kind === 'score_explanation';
    if (!used) continue;
    const t = langText(b);
    if (blank(t)) { if (b.kind !== 'disclaimer') err('language_text_missing', bp(b), { blockKey: b.blockKey }); } // V1 already reports a disclaimer
    else if (lib.language === 'en' ? DEVANAGARI.test(t!) : !DEVANAGARI.test(t!)) err('wrong_script', bp(b), { blockKey: b.blockKey });
  }

  // V10 rule and block kinds agree
  for (const r of lib.rules) {
    const b = blockById.get(r.blockId);
    if (!b || b.kind !== r.blockKind || b.kind !== r.ruleKind) err('block_kind_mismatch', `/rules/${r.id}`);
  }

  // V12 / V13 warnings
  for (const b of lib.blocks) if (!rulesByBlock.has(b.id) && b.kind !== 'disclaimer' && b.kind !== 'score_explanation') warn('block_unused', bp(b), { blockKey: b.blockKey });
  for (const m of lib.mappings) if (env.inactiveAnalyteIds.has(m.analyteId)) warn('analyte_inactive', `/mappings/${m.id}`);

  // V14
  if (lib.mappings.length === 0) err('no_mappings', '/mappings');

  return { valid: errors.length === 0, errors, warnings };
}
