// C14 TRD §4.12 — LLM output validator L1-L8 (AC-20.3). Pure: no I/O, never mutates arguments. LLM output is untrusted (07-SECURITY #101).
// A failing item keeps the approved template text; nothing is thrown. Failure codes are the §4.12 codes verbatim.
import { denyTermHits, normaliseForMatch } from '../domain/wording.js';
import { FUNCTION_WORDS_EN } from './function-words.en.js';
import type { LlmRephraseInput, LlmRephraseOutput } from './LlmRephraser.js';

export type LlmFailureCode =
  | 'placeholder_mismatch' | 'digit_added' | 'deny_term' | 'contact_or_link'
  | 'wrong_script' | 'length_out_of_bounds' | 'novel_word' | 'item_mismatch';

export interface LlmItemResult { itemRef: string; passed: boolean; failureCodes: LlmFailureCode[]; finalText: string }
export interface LlmValidationReport { items: LlmItemResult[]; extraItemRefs: string[]; allPassed: boolean }

const TOKEN = /\{[a-z_]+\}/g;
const DIGIT = /[0-9०-९]/;
const DEVANAGARI_LETTER = /(?=\p{L})\p{Script=Devanagari}/u; // letters only: excludes digits U+0966-096F and danda
const WORD = /[\p{L}\p{M}]+/gu; // letter runs; marks kept so Devanagari vowel signs do not split words
const PHONE = /\+?[0-9०-९][0-9०-९ -]{6,}/; // same as V8 (domain/library.validate.ts)
const MIN_WORD = 4;

/** V8 e-mail shape without a backtracking regex: whitespace-free token with an "@" that is neither first nor last. Linear. */
function hasEmailShape(text: string): boolean {
  for (const tok of text.split(/\s+/)) {
    for (let i = tok.indexOf('@'); i !== -1; i = tok.indexOf('@', i + 1)) if (i > 0 && i < tok.length - 1) return true;
  }
  return false;
}
function hasContactOrLink(text: string): boolean {
  const t = normaliseForMatch(text);
  return t.includes('http') || t.includes('www.') || hasEmailShape(t) || PHONE.test(t);
}

const placeholderKey = (text: string): string => [...text.matchAll(TOKEN)].map((m) => m[0]).sort().join('');

const words = (text: string): string[] =>
  (normaliseForMatch(text.replace(TOKEN, ' ')).match(WORD) ?? []).filter((w) => [...w].length >= MIN_WORD);

function checkText(template: string, text: string, language: 'en' | 'ne', denyTerms: readonly { term: string }[]): LlmFailureCode[] {
  const out: LlmFailureCode[] = [];
  if (placeholderKey(template) !== placeholderKey(text)) out.push('placeholder_mismatch'); // L1
  if (DIGIT.test(text)) out.push('digit_added'); // L2
  if (denyTermHits(text, denyTerms).length > 0) out.push('deny_term'); // L3
  if (hasContactOrLink(text)) out.push('contact_or_link'); // L4
  if (DEVANAGARI_LETTER.test(text) !== (language === 'ne')) out.push('wrong_script'); // L5
  if (text.length < template.length * 0.5 || text.length > template.length * 1.5) out.push('length_out_of_bounds'); // L6 [CONV] inclusive
  const known = new Set(words(template)); // L7 [DECISION]: ne = input words only
  if (words(text).some((w) => !known.has(w) && !(language === 'en' && FUNCTION_WORDS_EN.has(w)))) out.push('novel_word');
  return out;
}

export function validateLlmOutput(
  input: LlmRephraseInput,
  output: LlmRephraseOutput['items'],
  opts: { readonly denyTerms: readonly { term: string }[] },
): LlmValidationReport {
  const byRef = new Map<string, string[]>();
  for (const o of output) byRef.set(o.itemRef, [...(byRef.get(o.itemRef) ?? []), o.text]);
  const inputRefs = new Set(input.items.map((i) => i.itemRef));
  const extraItemRefs = [...byRef.keys()].filter((r) => !inputRefs.has(r)); // L8 extras, first-seen order

  const items = input.items.map((it): LlmItemResult => {
    const got = byRef.get(it.itemRef);
    // L8: exactly one output per input ref; otherwise there is no single text to check.
    const failureCodes = got?.length === 1 ? checkText(it.templateText, got[0] as string, input.language, opts.denyTerms) : ['item_mismatch' as const];
    const passed = failureCodes.length === 0;
    return { itemRef: it.itemRef, passed, failureCodes, finalText: passed ? (got as string[])[0] as string : it.templateText };
  });
  return { items, extraItemRefs, allPassed: extraItemRefs.length === 0 && items.every((i) => i.passed) };
}
