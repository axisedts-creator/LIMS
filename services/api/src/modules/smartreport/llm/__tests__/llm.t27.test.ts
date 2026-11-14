// C14 T27 — LLM output validator L1-L8. AC-20.3. Specs: 02-TRD §4.12 (L1-L8), §9.5 (deny normalisation), V8 regexes; 07-SECURITY §101 (LLM output untrusted).
//
// Contract chosen by these tests (TRD gives checks + failure codes, not the function shape):
//   validateLlmOutput(input: LlmRephraseInput, output: LlmRephraseOutput['items'], opts: { denyTerms: readonly { term: string }[] })
//     -> { items: { itemRef, passed, failureCodes: string[], finalText }[]   // one per INPUT item, input order
//          extraItemRefs: string[],                                          // output refs not in input (L8)
//          allPassed: boolean }
//   finalText = output text when passed, else the approved template text (AC-20.3: template text is kept, nothing thrown).
import { describe, expect, it } from 'vitest';
import type { LlmRephraseInput } from '../LlmRephraser.js';
import { validateLlmOutput } from '../validator.js';

const DENY = [{ term: 'cure' }, { term: 'diagnos' }, { term: 'buy' }, { term: 'http' }, { term: 'www.' }, { term: 'उपचार' }];
const item = (itemRef: string, templateText: string) => ({ itemRef, templateText });
const inp = (items: { itemRef: string; templateText: string }[], language: 'en' | 'ne' = 'en'): LlmRephraseInput =>
  ({ language, promptTemplateVersion: 'p1', items });
const run = (input: LlmRephraseInput, out: { itemRef: string; text: string }[], denyTerms = DENY) => validateLlmOutput(input, out, { denyTerms });
/** Single item helper: returns that item's result. */
const one = (templateText: string, text: string, language: 'en' | 'ne' = 'en', denyTerms = DENY) =>
  run(inp([item('advice:a1', templateText)], language), [{ itemRef: 'advice:a1', text }], denyTerms).items[0]!;
const codes = (r: { failureCodes: string[] }) => [...r.failureCodes].sort();

const T_EN = 'Your {analyte_name} result is outside the usual range. Please discuss it with your doctor.';
const OK_EN = 'Your {analyte_name} result is outside the usual range, please discuss this with your doctor.';
const T_NE = 'तपाईंको {analyte_name} नतिजा सामान्य सीमा बाहिर छ। कृपया डाक्टरसँग छलफल गर्नुहोस्।';
const OK_NE = 'कृपया डाक्टरसँग छलफल गर्नुहोस्। तपाईंको {analyte_name} नतिजा सामान्य सीमा बाहिर छ।';
/** exactly n chars, only words < 4 letters so L7 can never fire; no digits/spaces. */
const pad = (n: number) => 'the-'.repeat(n).slice(0, n);

describe('T27 baseline (AC-20.3 pass path)', () => {
  it('valid en rephrase passes all checks and finalText is the LLM text', () => {
    const r = one(T_EN, OK_EN);
    expect(r.failureCodes).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.finalText).toBe(OK_EN);
  });
  it('valid ne rephrase passes (Devanagari present, words from input only)', () => {
    const r = one(T_NE, OK_NE, 'ne');
    expect(r.failureCodes).toEqual([]);
    expect(r.passed).toBe(true);
  });
  it('failing item keeps the approved template text, does not throw (AC-20.3)', () => {
    const r = one(T_EN, 'Your {analyte_name} result is outside the usual range. Take 5 pills.');
    expect(r.passed).toBe(false);
    expect(r.finalText).toBe(T_EN);
  });
  it('does not mutate its arguments', () => {
    const input = inp([item('advice:a1', T_EN)]);
    const out = [{ itemRef: 'advice:a1', text: OK_EN }];
    const a = JSON.stringify([input, out]);
    run(input, out);
    expect(JSON.stringify([input, out])).toBe(a);
  });
});

describe('T27 L1 placeholder multiset -> placeholder_mismatch', () => {
  const T = 'Your {analyte_name} is {value} {unit}, range {ref_range}.';
  it('pass: same multiset in different order', () => {
    const r = one(T, 'Range {ref_range}, your {analyte_name} is {value} {unit}.');
    expect(r.failureCodes).not.toContain('placeholder_mismatch');
  });
  it('fail: placeholder dropped', () => {
    expect(one(T, 'Your {analyte_name} is {value}, range {ref_range}.').failureCodes).toContain('placeholder_mismatch');
  });
  it('fail: placeholder added', () => {
    expect(one(T, 'Your {analyte_name} is {value} {unit}, range {ref_range} {group_name}.').failureCodes).toContain('placeholder_mismatch');
  });
  it('fail: placeholder renamed', () => {
    expect(one(T, 'Your {test_name} is {value} {unit}, range {ref_range}.').failureCodes).toContain('placeholder_mismatch');
  });
  it('fail: multiplicity differs (duplicated / collapsed)', () => {
    expect(one('Check {value} and {value} again.', 'Check {value} again.').failureCodes).toContain('placeholder_mismatch');
    expect(one('Check {value} again.', 'Check {value} and {value} again.').failureCodes).toContain('placeholder_mismatch');
  });
  it('fail: placeholder filled with a literal value instead of kept', () => {
    expect(one('Your {analyte_name} is high.', 'Your hemoglobin is high.').failureCodes).toContain('placeholder_mismatch');
  });
  it('pass: no placeholders on either side', () => {
    expect(one('Drink enough water daily.', 'Please drink enough water daily.').failureCodes).not.toContain('placeholder_mismatch');
  });
});

describe('T27 L2 digits -> digit_added', () => {
  it('pass: no digits', () => expect(one(T_EN, OK_EN).failureCodes).not.toContain('digit_added'));
  it('fail: ASCII digit', () => expect(one(T_EN, OK_EN.replace('range', 'range 3')).failureCodes).toContain('digit_added'));
  it('fail: Devanagari digit', () => expect(one(T_NE, OK_NE + ' ३', 'ne').failureCodes).toContain('digit_added'));
  it('fail: Devanagari digit in en output', () => expect(one(T_EN, OK_EN + ' ३').failureCodes).toContain('digit_added'));
  it('fail: digit glued inside a word', () => expect(one(T_EN, OK_EN.replace('doctor', 'doctor2')).failureCodes).toContain('digit_added'));
});

describe('T27 L3 deny terms (§9.5 normalisation) -> deny_term', () => {
  it('pass: no deny term', () => expect(one(T_EN, OK_EN).failureCodes).not.toContain('deny_term'));
  it('fail: plain Latin term', () => expect(one(T_EN, OK_EN + ' This can cure it.').failureCodes).toContain('deny_term'));
  it('fail: case folded', () => expect(one(T_EN, OK_EN + ' This can CURE it.').failureCodes).toContain('deny_term'));
  it('fail: zero-width characters inside the term', () => {
    expect(one(T_EN, OK_EN + ' This can cu​re it.').failureCodes).toContain('deny_term');
    expect(one(T_EN, OK_EN + ' This can c﻿u‍re it.').failureCodes).toContain('deny_term');
  });
  it('fail: prefix-style term matches at word start (diagnos -> diagnosis)', () => {
    expect(one(T_EN, OK_EN + ' Diagnosis follows.').failureCodes).toContain('deny_term');
  });
  it('pass: Latin term only mid-word does not match (secure vs cure)', () => {
    const t = 'Keep your {analyte_name} report secure and discuss it with your doctor.';
    expect(one(t, 'Please keep your {analyte_name} report secure and discuss it with your doctor.').failureCodes).not.toContain('deny_term');
  });
  it('fail: Devanagari term matches as substring', () => {
    expect(one(T_NE, OK_NE + ' उपचारित', 'ne').failureCodes).toContain('deny_term');
  });
  it('fail: tenant-added term is honoured; pass when list is empty', () => {
    expect(one(T_EN, OK_EN + ' Visit our clinic.', 'en', [{ term: 'clinic' }]).failureCodes).toContain('deny_term');
    expect(one(T_EN, OK_EN, 'en', []).failureCodes).not.toContain('deny_term');
  });
});

describe('T27 L4 URL / e-mail / phone shapes -> contact_or_link', () => {
  const bad = (s: string) => expect(one(T_EN, OK_EN + ' ' + s).failureCodes).toContain('contact_or_link');
  it('pass: none present', () => expect(one(T_EN, OK_EN).failureCodes).not.toContain('contact_or_link'));
  it('fail: http URL', () => bad('See http://example.org now.'));
  it('fail: www. URL', () => bad('See www.example.org now.'));
  it('fail: e-mail', () => bad('Write to person@example.org.'));
  it('fail: phone with plus and spaces', () => bad('Call +977 9841 234 567.'));
  it('fail: phone with Devanagari digits', () => bad('फोन ९८४१२३४५६७'));
  it('does not regex-backtrack catastrophically on long hostile output', () => {
    const t0 = Date.now();
    one(T_EN, 'a'.repeat(20000) + ' ' + 'a@'.repeat(5000));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('T27 L5 script -> wrong_script', () => {
  it('pass: en without Devanagari', () => expect(one(T_EN, OK_EN).failureCodes).not.toContain('wrong_script'));
  it('fail: en output containing a Devanagari letter', () => expect(one(T_EN, OK_EN + ' डाक्टर').failureCodes).toContain('wrong_script'));
  it('pass: ne output with Devanagari', () => expect(one(T_NE, OK_NE, 'ne').failureCodes).not.toContain('wrong_script'));
  it('fail: ne output with no Devanagari letter (Latin only)', () => {
    expect(one(T_NE, 'Your {analyte_name} result is outside the usual range.', 'ne').failureCodes).toContain('wrong_script');
  });
  it('fail: ne output with only Devanagari digits/danda is not enough (needs a letter)', () => {
    expect(one(T_NE, '{analyte_name} । ३', 'ne').failureCodes).toContain('wrong_script');
  });
});

describe('T27 L6 length 50%-150% (inclusive) -> length_out_of_bounds', () => {
  const T = pad(100);
  it('pass at exactly 50% and 100% and 150%', () => {
    for (const n of [50, 100, 150]) expect(one(T, pad(n)).failureCodes, `len ${n}`).not.toContain('length_out_of_bounds');
  });
  it('fail at 49 and 151 chars', () => {
    for (const n of [49, 151]) expect(one(T, pad(n)).failureCodes, `len ${n}`).toContain('length_out_of_bounds');
  });
  it('fail: empty output', () => expect(one(T, '').failureCodes).toContain('length_out_of_bounds'));
  it('fail: far too long output', () => expect(one(T, pad(5000)).failureCodes).toContain('length_out_of_bounds'));
});

describe('T27 L7 novelty -> novel_word', () => {
  it('pass: words from input + function words only', () => expect(one(T_EN, OK_EN).failureCodes).not.toContain('novel_word'));
  it('fail: new content word (en)', () => {
    expect(one(T_EN, OK_EN.replace('doctor', 'physician')).failureCodes).toContain('novel_word');
    expect(one(T_EN, OK_EN + ' Hydration helps.').failureCodes).toContain('novel_word');
  });
  it('pass: new word shorter than 4 letters is exempt', () => {
    expect(one(T_EN, OK_EN.replace('discuss', 'ask')).failureCodes).not.toContain('novel_word');
  });
  it('pass: case-folded match (UPPERCASE of an input word)', () => {
    expect(one(T_EN, OK_EN.replace('doctor', 'DOCTOR')).failureCodes).not.toContain('novel_word');
  });
  it('pass: NFC-equivalent form of an input word', () => {
    const t = 'Visit the café for your {analyte_name} advice please.';
    expect(one(t, 'Please visit the café for your {analyte_name} advice.').failureCodes).not.toContain('novel_word');
  });
  it('letters only: word split by punctuation uses letter runs (doctor/doctor!)', () => {
    expect(one(T_EN, OK_EN.replace('doctor', 'doctor!!')).failureCodes).not.toContain('novel_word');
  });
  it('fail: function-word list is not a free pass for health words (medicine)', () => {
    expect(one(T_EN, OK_EN + ' medicine').failureCodes).toContain('novel_word');
  });
  it('ne: only input words allowed; reorder passes, new Devanagari word fails', () => {
    expect(one(T_NE, OK_NE, 'ne').failureCodes).not.toContain('novel_word');
    expect(one(T_NE, OK_NE + ' अतिरिक्त', 'ne').failureCodes).toContain('novel_word');
  });
  it('ne: English function words are NOT allowed (input words only)', () => {
    expect(one(T_NE, OK_NE + ' please', 'ne').failureCodes).toContain('novel_word');
  });
});

describe('T27 L8 one output per input itemRef -> item_mismatch', () => {
  const input = inp([item('deranged:r1', T_EN), item('advice:b1', 'Drink enough water daily.')]);
  const o1 = { itemRef: 'deranged:r1', text: OK_EN };
  const o2 = { itemRef: 'advice:b1', text: 'Please drink enough water daily.' };

  it('pass: exactly one output per input, any order', () => {
    const r = run(input, [o2, o1]);
    expect(r.items.map((x) => x.itemRef)).toEqual(['deranged:r1', 'advice:b1']); // input order
    expect(r.items.every((x) => x.passed)).toBe(true);
    expect(r.extraItemRefs).toEqual([]);
    expect(r.allPassed).toBe(true);
  });
  it('fail: missing output keeps template, other item unaffected', () => {
    const r = run(input, [o1]);
    expect(r.items[1]!.failureCodes).toContain('item_mismatch');
    expect(r.items[1]!.finalText).toBe('Drink enough water daily.');
    expect(r.items[0]!.passed).toBe(true);
    expect(r.allPassed).toBe(false);
  });
  it('fail: duplicate outputs for one itemRef', () => {
    const r = run(input, [o1, o1, o2]);
    expect(r.items[0]!.failureCodes).toContain('item_mismatch');
    expect(r.items[0]!.finalText).toBe(T_EN);
    expect(r.items[1]!.passed).toBe(true);
  });
  it('fail: extra unknown itemRef is reported, never becomes an item', () => {
    const r = run(input, [o1, o2, { itemRef: 'advice:zzz', text: 'Buy now.' }]);
    expect(r.extraItemRefs).toEqual(['advice:zzz']);
    expect(r.items).toHaveLength(2);
    expect(r.allPassed).toBe(false);
  });
  it('empty output list: every item mismatched', () => {
    const r = run(input, []);
    expect(r.items.map((x) => x.failureCodes.includes('item_mismatch'))).toEqual([true, true]);
  });
});

describe('T27 combined', () => {
  it('multiple failures are all reported, one entry per code (no duplicates)', () => {
    const r = one(T_EN, 'Your {value} result: buy cure at http://x.org 3 times!');
    for (const c of ['placeholder_mismatch', 'digit_added', 'deny_term', 'contact_or_link', 'novel_word']) expect(r.failureCodes).toContain(c);
    expect(codes(r)).toEqual([...new Set(r.failureCodes)].sort());
    expect(r.passed).toBe(false);
  });
  it('only documented failure codes are ever emitted', () => {
    const allowed = ['placeholder_mismatch', 'digit_added', 'deny_term', 'contact_or_link', 'wrong_script', 'length_out_of_bounds', 'novel_word', 'item_mismatch'];
    const r = one(T_EN, '३ http://x@y.z डाक्टर buy {zzz}');
    for (const c of r.failureCodes) expect(allowed).toContain(c);
  });
});
