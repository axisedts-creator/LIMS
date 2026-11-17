// Wording normaliser + deny-term matcher (02-TRD §9.5; PRD AC-18.3; 07-SECURITY AB-2). Pure; no regex is built from a term (terms are literals, no ReDoS).
const ZERO_WIDTH = /[​‌‍﻿]/g;
const DEVANAGARI = /[ऀ-ॿ]/;

/** NFC -> remove U+200B/200C/200D/FEFF -> Unicode lower-case (und locale, so never the Turkish rule). */
export const normaliseForMatch = (text: string): string => text.normalize('NFC').replace(ZERO_WIDTH, '').toLocaleLowerCase('und');

const isAsciiLower = (c: number): boolean => c >= 0x61 && c <= 0x7a;

/** Is `needle` in `hay` starting at a word start, i.e. /(^|[^a-z])needle/ ? */
function atWordStart(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (i === 0 || !isAsciiLower(hay.charCodeAt(i - 1))) return true;
  }
  return false;
}

/** Supplied `term` values that occur in `text`: Devanagari terms as substrings, all others at a word start. Input order, no duplicates, '' never matches. */
export function denyTermHits(text: string, terms: readonly { term: string }[]): string[] {
  const hay = normaliseForMatch(text);
  const out: string[] = [];
  for (const { term } of terms) {
    const needle = normaliseForMatch(term);
    if (needle === '' || out.includes(term)) continue;
    if (DEVANAGARI.test(needle) ? hay.includes(needle) : atWordStart(hay, needle)) out.push(term);
  }
  return out;
}
