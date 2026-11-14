// FD-T02 patient.ts (02-TRD §3.1; US-FD-02.1, 02.2). Synthetic names only.
// Assumed API: normaliseName(s), estimatedBirthOn(ageYears, asOf 'YYYY-MM-DD') -> 'YYYY-MM-DD', ageDisplay(birthOn, asOf), isDuplicateSuspect(a, b).
import { describe, expect, it } from 'vitest';
import { ageDisplay, estimatedBirthOn, isDuplicateSuspect, normaliseName } from '../patient.js';

describe('normaliseName (NFC, case fold, whitespace)', () => {
  it('lower-cases, trims, collapses internal whitespace (space, tab, NBSP, ideographic)', () => {
    expect(normaliseName('  RAM \t Bahadur 　Sharma  ')).toBe('ram bahadur sharma');
  });
  it('NFC-composes Latin: decomposed e + U+0301 equals precomposed', () => {
    expect(normaliseName('José')).toBe(normaliseName('José'));
    expect(normaliseName('José')).toBe('josé');
  });
  it('Devanagari: already-NFC text is unchanged (परीक्षण)', () => {
    expect(normaliseName('परीक्षण')).toBe('परीक्षण');
  });
  it('Devanagari: composition-excluded U+0958 (क़) normalises to क + nukta so both typings match', () => {
    expect(normaliseName('क़')).toBe('क़');
    expect(normaliseName('क़ा')).toBe(normaliseName('क़ा'));
  });
  it('Devanagari with surrounding/internal whitespace', () => {
    expect(normaliseName(' राम   बहादुर ')).toBe('राम बहादुर');
  });
  it('mixed script keeps both parts; Devanagari is not altered by case folding', () => {
    expect(normaliseName('Ram राम')).toBe('ram राम');
  });
  it('empty / whitespace-only -> empty string', () => {
    expect(normaliseName('')).toBe('');
    expect(normaliseName(' \t ')).toBe('');
  });
  it('is idempotent', () => {
    for (const s of ['  RAM  Sharma ', 'क़ x', 'José']) expect(normaliseName(normaliseName(s))).toBe(normaliseName(s));
  });
});

describe('estimatedBirthOn (US-FD-02.1: age 43 y, no DOB)', () => {
  it('age 43 on 2026-11-07 -> 1983-11-07', () => {
    expect(estimatedBirthOn(43, '2026-11-07')).toBe('1983-11-07');
  });
  it('age 0 -> same day', () => {
    expect(estimatedBirthOn(0, '2026-11-07')).toBe('2026-11-07');
  });
  it('Feb 29 minus whole years lands on Feb 28 when target year is not leap', () => {
    expect(estimatedBirthOn(1, '2028-02-29')).toBe('2027-02-28');
    expect(estimatedBirthOn(4, '2028-02-29')).toBe('2024-02-29');
  });
  it('round-trips: ageDisplay of the estimate equals the stated age', () => {
    expect(ageDisplay(estimatedBirthOn(43, '2026-11-07'), '2026-11-07')).toBe('43 Years');
  });
  it.each([-1, 1.5, 200, Number.NaN])('rejects age %s', (age) => {
    expect(() => estimatedBirthOn(age, '2026-11-07')).toThrow();
  });
});

describe('ageDisplay', () => {
  it('birthday today -> full year; day before birthday -> one less', () => {
    expect(ageDisplay('1983-11-07', '2026-11-07')).toBe('43 Years');
    expect(ageDisplay('1983-11-07', '2026-11-06')).toBe('42 Years');
  });
});

describe('isDuplicateSuspect (US-FD-02.2; name eq + birth year ±1 + same phone when both present)', () => {
  const base = { fullName: 'Sita Devi Thapa', birthOn: '1990-06-15', phoneE164: '+9779800000001' };
  const dup = (over: object) => isDuplicateSuspect(base, { ...base, ...over });
  it('identical -> true', () => expect(dup({})).toBe(true));
  it('case / whitespace differences -> true', () => expect(dup({ fullName: '  SITA  devi THAPA ' })).toBe(true));
  it('birth year ±1 -> true; ±2 -> false', () => {
    expect(dup({ birthOn: '1991-01-01' })).toBe(true);
    expect(dup({ birthOn: '1989-12-31' })).toBe(true);
    expect(dup({ birthOn: '1992-01-01' })).toBe(false);
    expect(dup({ birthOn: '1988-06-15' })).toBe(false);
  });
  it('different name -> false', () => expect(dup({ fullName: 'Sita Devi Thapa Magar' })).toBe(false));
  it('both phones present and different -> false', () => expect(dup({ phoneE164: '+9779800000002' })).toBe(false));
  it('a phone missing on either side is ignored', () => {
    expect(dup({ phoneE164: null })).toBe(true);
    expect(isDuplicateSuspect({ ...base, phoneE164: null }, base)).toBe(true);
  });
  it('anonymised candidate is never a duplicate', () => expect(dup({ anonymised: true })).toBe(false));
  it('is symmetric', () => {
    const b = { ...base, fullName: 'SITA DEVI THAPA', birthOn: '1991-02-02' };
    expect(isDuplicateSuspect(base, b)).toBe(isDuplicateSuspect(b, base));
  });
  it('Devanagari NFC variants of the same name match', () => {
    const a = { fullName: 'क़ुशी', birthOn: '2000-01-01', phoneE164: null };
    const b = { fullName: 'क़ुशी', birthOn: '2000-01-01', phoneE164: null };
    expect(isDuplicateSuspect(a, b)).toBe(true);
  });
});
