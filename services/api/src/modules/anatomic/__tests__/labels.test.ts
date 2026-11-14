// C11 T-02 — labels (02-TRD §4.3; AC-04.1, AC-04.3, AC-04.4). Pure.
// SEAMS (spec fixes rules/examples, not names):
//   ../domain/labels.ts  export function partLetter(n: number): string               n 1-based; bijective base-26; RangeError unless safe integer ≥ 1
//                        export function blockLabel(accessionNo, partLetter, blockSeq): string       `{acc}-{letter}{seq}`
//                        export function slideLabelFromBlock(blockLabel, slideSeq): string           `{block}-{seq}`
//                        export function slideLabelFromPart(accessionNo, partLetter, slideSeq): string `{acc}-{letter}-{seq}`
//   seq arguments are 1-based integers (RangeError otherwise); a label > 32 chars or outside [A-Z0-9-] -> RangeError.
// Fails now: ../domain/labels.js does not exist.
import { describe, expect, it } from 'vitest';
import { blockLabel, partLetter, slideLabelFromBlock, slideLabelFromPart } from '../domain/labels.js';

describe('C11 labels — part letters (bijective base-26)', () => {
  it.each([
    [1, 'A'], [2, 'B'], [25, 'Y'], [26, 'Z'],
    [27, 'AA'], [28, 'AB'], [52, 'AZ'], [53, 'BA'], [54, 'BB'],
    [702, 'ZZ'], [703, 'AAA'],
  ])('part #%i → %s', (n, letter) => expect(partLetter(n)).toBe(letter));

  it('the first 52 parts (A12 max) are unique and sequential', () => {
    const l = Array.from({ length: 52 }, (_, i) => partLetter(i + 1));
    expect(new Set(l).size).toBe(52);
    expect(l.slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(l.slice(24, 29)).toEqual(['Y', 'Z', 'AA', 'AB', 'AC']);
    expect(l[51]).toBe('AZ');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (n) => {
    expect(() => partLetter(n)).toThrow(RangeError);
  });
});

describe('C11 labels — block labels (AC-04.1 goldens)', () => {
  it('S26-0042 part A blocks 1..3 → S26-0042-A1, -A2, -A3; then 4, 5 → -A4, -A5', () => {
    expect([1, 2, 3].map((n) => blockLabel('S26-0042', 'A', n))).toEqual(['S26-0042-A1', 'S26-0042-A2', 'S26-0042-A3']);
    expect([4, 5].map((n) => blockLabel('S26-0042', 'A', n))).toEqual(['S26-0042-A4', 'S26-0042-A5']);
  });
  it('multi-letter part AA, double-digit seq', () => {
    expect(blockLabel('S26-0042', 'AA', 12)).toBe('S26-0042-AA12');
    expect(blockLabel('S26-0042', partLetter(2), 1)).toBe('S26-0042-B1');
  });
  it('rejects seq 0 / negative / fractional / NaN', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => blockLabel('S26-0042', 'A', n)).toThrow(RangeError);
  });
});

describe('C11 labels — slide from block (AC-04.3 goldens)', () => {
  it('block A1, 2 H&E slides → S26-0042-A1-1, S26-0042-A1-2', () => {
    const b = blockLabel('S26-0042', 'A', 1);
    expect([1, 2].map((n) => slideLabelFromBlock(b, n))).toEqual(['S26-0042-A1-1', 'S26-0042-A1-2']);
  });
  it('rejects seq 0 / negative / fractional', () => {
    for (const n of [0, -3, 2.5]) expect(() => slideLabelFromBlock('S26-0042-A1', n)).toThrow(RangeError);
  });
});

describe('C11 labels — slide from part, cytology smears (AC-04.4 goldens)', () => {
  it('cytology C26-0007 part A, 4 PAP slides → C26-0007-A-1 … -A-4', () => {
    expect([1, 2, 3, 4].map((n) => slideLabelFromPart('C26-0007', 'A', n))).toEqual([
      'C26-0007-A-1', 'C26-0007-A-2', 'C26-0007-A-3', 'C26-0007-A-4',
    ]);
  });
  it('part-slide label never collides with a block-slide label of the same part', () => {
    // block A1 slide 1 = "…-A1-1"; part A slide 1 = "…-A-1" — different strings by construction.
    expect(slideLabelFromPart('S26-0042', 'A', 1)).not.toBe(slideLabelFromBlock(blockLabel('S26-0042', 'A', 1), 1));
  });
});

describe('C11 labels — length ≤ 32 and charset [A-Z0-9-]', () => {
  it('exactly 32 chars is accepted', () => {
    const acc = 'A'.repeat(28); // 28 + '-' + 'A' + '1' = 31 ; use 29 → 32
    const ok = blockLabel('A'.repeat(29), 'A', 1);
    expect(ok.length).toBe(32);
    expect(acc.length).toBe(28);
  });
  it('33 chars is rejected for block, slide-from-block and slide-from-part', () => {
    expect(() => blockLabel('A'.repeat(30), 'A', 1)).toThrow(RangeError);
    expect(() => slideLabelFromBlock('A'.repeat(30) + '-A1', 1)).toThrow(RangeError);
    expect(() => slideLabelFromPart('A'.repeat(29), 'A', 1)).toThrow(RangeError);
  });
  it.each(['s26-0042', 'S26_0042', 'S26 0042', 'S26-0042\n', "S26-0042'--", '<b>'])('rejects accession_no %j', (acc) => {
    expect(() => blockLabel(acc, 'A', 1)).toThrow(RangeError);
    expect(() => slideLabelFromPart(acc, 'A', 1)).toThrow(RangeError);
  });
  it.each(['a', '1', 'A1', '-', '', 'A-'])('rejects part letter %j', (l) => {
    expect(() => blockLabel('S26-0042', l, 1)).toThrow(RangeError);
    expect(() => slideLabelFromPart('S26-0042', l, 1)).toThrow(RangeError);
  });
});
