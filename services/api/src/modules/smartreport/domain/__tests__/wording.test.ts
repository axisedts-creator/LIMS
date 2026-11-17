// C14 T03 — wording normaliser + deny-term matcher (06-PLAN row T03; 02-TRD §9.5; PRD AC-18.3; 07-SECURITY abuse case AB-2, test plan item 7).
// done_when: "normalisation rules (NFC, zero-width, case fold)". Tests: unit.
// SEAMS (spec fixes the rules, not the names; writer must export exactly these from ../wording.ts):
//   normaliseForMatch(text: string): string
//       TRD §9.5 order: text.normalize('NFC') -> remove U+200B, U+200C, U+200D, U+FEFF -> toLocaleLowerCase('und'). Pure, idempotent, never throws on a string.
//   denyTermHits(text: string, terms: readonly { term: string }[]): string[]
//       Normalises text AND every term with normaliseForMatch. A term containing any Devanagari char (U+0900–U+097F) matches as a SUBSTRING;
//       every other term matches on WORD START: /(^|[^a-z])<term>/ on the folded text (term is a LITERAL, never a pattern).
//       A term that folds to '' never matches. Returns the `term` values (as supplied) of the terms that hit, in input order, without duplicates.
// Fails now: ../wording.js does not exist.
import { describe, expect, it } from 'vitest';
import { denyTermHits, normaliseForMatch } from '../wording.js';

const T = (...terms: string[]) => terms.map((term) => ({ term }));
const hits = (text: string, ...terms: string[]) => denyTermHits(text, T(...terms));

describe('C14-T03 normaliseForMatch (TRD §9.5)', () => {
  it('NFC: decomposed and composed forms are equal (Latin and Devanagari composition-excluded letter)', () => {
    expect(normaliseForMatch('café')).toBe('café');
    expect(normaliseForMatch('café')).toBe('café');
    expect(normaliseForMatch('ड़')).toBe('ड़'); // NFC of DDDHA = DDA + NUKTA
    expect(normaliseForMatch('ड़')).toBe('ड़');
  });

  it.each([['U+200B', '​'], ['U+200C', '‌'], ['U+200D', '‍'], ['U+FEFF', '﻿']])('removes %s anywhere (start, middle, end, repeated)', (_n, zw) => {
    expect(normaliseForMatch(`${zw}supp${zw}${zw}lement${zw}`)).toBe('supplement');
  });

  it('removes zero-width characters inside Devanagari text too', () => {
    expect(normaliseForMatch('द‍वा')).toBe('दवा');
  });

  it('case fold: Unicode lower-casing with the und locale', () => {
    expect(normaliseForMatch('ORDER Now')).toBe('order now');
    expect(normaliseForMatch('ÀBÉ')).toBe('àbé');
    expect(normaliseForMatch('İ')).toBe('i̇'); // dotted capital I -> i + combining dot (locale-independent, not tr)
  });

  it('leaves everything else alone (digits, punctuation, spaces, Devanagari letters, other whitespace)', () => {
    const s = 'rs. 500 www.x.com a b c दवा';
    expect(normaliseForMatch(s)).toBe(s);
  });

  it('is idempotent, total on the empty string and on a lone zero-width run', () => {
    for (const s of ['', '​‌‍﻿', 'CAFÉ ​x', 'ड़‍']) {
      expect(normaliseForMatch(normaliseForMatch(s)), JSON.stringify(s)).toBe(normaliseForMatch(s));
    }
    expect(normaliseForMatch('')).toBe('');
    expect(normaliseForMatch('​‌‍﻿')).toBe('');
  });
});

describe('C14-T03 denyTermHits — AC-18.3: ignores case, NFC differences, zero-width characters', () => {
  it('case: every capitalisation of text and of term', () => {
    expect(hits('This is a GUARANTEED CURE', 'cure')).toEqual(['cure']);
    expect(hits('this is a cure', 'CURE')).toEqual(['CURE']);
    expect(hits('Order NOW and save', 'order now')).toEqual(['order now']);
  });

  it('NFC: decomposed text vs composed term and the reverse', () => {
    expect(hits('Fresh café here', 'café')).toEqual(['café']);
    expect(hits('Fresh café here', 'café')).toEqual(['café']);
    expect(hits('अड़ी', 'अड़ी')).toEqual(['अड़ी']); // Devanagari, NFC difference
  });

  it.each([['U+200B', '​'], ['U+200C', '‌'], ['U+200D', '‍'], ['U+FEFF', '﻿']])('zero-width %s inside the text cannot hide a term (AB-2)', (_n, zw) => {
    expect(hits(`Buy a supp${zw}lement now`, 'supplement')).toEqual(['supplement']);
    expect(hits(`order${zw} now`, 'order now')).toEqual(['order now']);
    expect(hits(`${zw}c${zw}u${zw}r${zw}e`, 'cure')).toEqual(['cure']);
  });

  it('zero-width characters inside the TERM are ignored as well', () => {
    expect(hits('a cure for all', 'cu​re')).toEqual(['cu​re']);
  });

  it('all three at once: mixed case + NFC difference + zero-width', () => {
    expect(hits('CAFÉ ​OFFER', 'café offer')).toEqual(['café offer']);
    expect(hits('S​uPp‍LEMENT', 'supplement')).toEqual(['supplement']);
  });
});

describe('C14-T03 denyTermHits — TRD §9.5 matching rules', () => {
  it('Latin terms match on word start: (^|[^a-z])term on the folded text', () => {
    expect(hits('cure', 'cure')).toEqual(['cure']);
    expect(hits('a cure.', 'cure')).toEqual(['cure']);
    expect(hits('(cure)', 'cure')).toEqual(['cure']);
    expect(hits('cure-all', 'cure')).toEqual(['cure']);
    expect(hits('2cure', 'cure')).toEqual(['cure']);          // a digit is not [a-z]
    expect(hits('Diagnosis', 'diagnos')).toEqual(['diagnos']); // stems match the start of a longer word
    expect(hits('curelike', 'cure')).toEqual(['cure']);
  });

  it('Latin terms do NOT match inside a word', () => {
    expect(hits('secure', 'cure')).toEqual([]);
    expect(hits('overdose', 'dose')).toEqual([]);
    expect(hits('Obuy', 'buy')).toEqual([]);
  });

  it('Devanagari terms match as substrings (no word start rule)', () => {
    expect(hits('यह दवा है', 'दवा')).toEqual(['दवा']);
    expect(hits('यहदवाहै', 'दवा')).toEqual(['दवा']);
    expect(hits('दव', 'दवा')).toEqual([]);
  });

  it('a term with any Devanagari character is a substring term even when it also holds Latin letters', () => {
    expect(hits('xxabcदवाyy', 'abcदवा')).toEqual(['abcदवा']);
  });

  it('terms are literals, never patterns (dot, parentheses, plus, anchors, star)', () => {
    expect(hits('Rs. 500', 'rs.')).toEqual(['rs.']);
    expect(hits('Rsx 500', 'rs.')).toEqual([]);                 // "." is not "any char"
    expect(hits('wwwx', 'www.')).toEqual([]);
    expect(hits('see www.example', 'www.')).toEqual(['www.']);
    expect(hits('cure', '^cure$')).toEqual([]);
    expect(hits('abc', '.*')).toEqual([]);
    expect(hits('aaa', '(a+)+')).toEqual([]);
    expect(hits('see (a+)+ here', '(a+)+')).toEqual(['(a+)+']);
  });

  it('a term that folds to the empty string never matches (it would otherwise match everything)', () => {
    expect(hits('anything at all', '')).toEqual([]);
    expect(hits('anything at all', '​')).toEqual([]);
    expect(hits('anything at all', '​‌‍﻿')).toEqual([]);
  });

  it('returns the supplied term values in input order, once each, and nothing for clean text', () => {
    expect(hits('Buy this cure. Cure now!', 'cure', 'buy', 'dose', 'cure')).toEqual(['cure', 'buy']);
    expect(hits('', 'cure')).toEqual([]);
    expect(hits('The score is within the reference range.', 'cure', 'diagnos', 'supplement', 'http', 'www.')).toEqual([]);
    expect(denyTermHits('cure', [])).toEqual([]);
  });

  it('pathological input stays fast and correct (no regex backtracking, no quadratic blow-up)', () => {
    const big = `${'a'.repeat(200_000)}!`;
    const t0 = Date.now();
    expect(hits(big, '(a+)+$', 'cure')).toEqual([]);
    expect(hits(`${'​'.repeat(200_000)}cure`, 'cure')).toEqual(['cure']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('the global seed stems (TRD §9.5) all fire on a plain sentence, and the starter score explanation avoids them (08 A19 D-108)', () => {
    const seed = ['diagnos', 'cure', 'guarantee', 'buy', 'order now', 'discount', 'offer', 'supplement', 'capsule', 'tablet', 'dose', 'prescri', 'medicine', 'herbal', 'ayurved', 'price', 'rs.', 'npr', 'call us', 'hotline', 'whatsapp', 'http', 'www.'];
    for (const s of seed) expect(hits(`Please note: ${s.toUpperCase()} today`, s), s).toEqual([s]);
    const explanation = 'The health score shows how many of your measured results are within the reference range, averaged across the body systems tested. It does not tell you whether you have a disease.';
    expect(denyTermHits(explanation, T(...seed))).toEqual([]);
    expect(hits('Health score (not a diagnosis)', 'diagnos')).toEqual(['diagnos']); // why that label is renderer copy, not library text
  });
});
