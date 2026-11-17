// C14 T06 — domain/placeholders.ts (02-TRD §4.9; AC-03.1 placeholder list, AC-03.4 / V4 allowed-per-kind).
// API pinned by these tests (spec gives no names):
//   ALLOWED_PLACEHOLDERS: Record<BlockKind, readonly string[]>
//   extractPlaceholders(text) -> string[]            unique, order of first appearance; syntax {name}, name in [a-z_]+
//   unknownPlaceholders(kind, text) -> string[]      names used but not allowed for kind
//   fillPlaceholders(text, values) -> string         single pass; throws if a used placeholder has no value
//   refRangeText({low?, high?, text?}) -> string | undefined
//   derangedPlaceholderValues({ analyte:{name,printName?}, result:{valueNumeric?,valueText?,ordinalCode?,unitCode?},
//                               referenceRangeSnapshot?, groupName }) -> { analyte_name, value, unit?, ref_range?, group_name }
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PLACEHOLDERS,
  derangedPlaceholderValues,
  extractPlaceholders,
  fillPlaceholders,
  refRangeText,
  unknownPlaceholders,
} from '../placeholders.js';

describe('allowed placeholders per kind (§4.9 table)', () => {
  it('matches the table exactly', () => {
    expect([...ALLOWED_PLACEHOLDERS.deranged].sort()).toEqual(['analyte_name', 'group_name', 'ref_range', 'unit', 'value']);
    expect([...ALLOWED_PLACEHOLDERS.advice].sort()).toEqual(['analyte_name', 'group_name']);
    expect([...ALLOWED_PLACEHOLDERS.followup].sort()).toEqual(['analyte_name', 'group_name', 'interval_days', 'test_name']);
    expect(ALLOWED_PLACEHOLDERS.disclaimer).toEqual([]);
    expect(ALLOWED_PLACEHOLDERS.score_explanation).toEqual([]);
  });
});

describe('extractPlaceholders', () => {
  it('AC-03.1: single placeholder', () => {
    expect(extractPlaceholders('{analyte_name} is above the reference range of your laboratory.')).toEqual(['analyte_name']);
  });
  it('unique, first-appearance order', () => {
    expect(extractPlaceholders('{unit} {analyte_name} {unit} {value}')).toEqual(['unit', 'analyte_name', 'value']);
  });
  it('ignores tokens outside [a-z_]+ and stray braces', () => {
    expect(extractPlaceholders('{Dose} {a1} {} { x } {a-b} }{ plain')).toEqual([]);
  });
  it('Devanagari text with a placeholder', () => {
    expect(extractPlaceholders('{analyte_name} सन्दर्भ दायरा भन्दा माथि छ।')).toEqual(['analyte_name']);
  });
  it('no placeholders', () => {
    expect(extractPlaceholders('plain text')).toEqual([]);
  });
});

describe('unknownPlaceholders (V4 / AC-03.4)', () => {
  it('AC-03.4: {dose} unknown for deranged', () => {
    expect(unknownPlaceholders('deranged', '{analyte_name} {dose}')).toEqual(['dose']);
  });
  it('allowed-set is per kind', () => {
    expect(unknownPlaceholders('deranged', '{value} {unit} {ref_range} {group_name}')).toEqual([]);
    expect(unknownPlaceholders('advice', '{value}')).toEqual(['value']);
    expect(unknownPlaceholders('followup', '{test_name} {interval_days}')).toEqual([]);
    expect(unknownPlaceholders('disclaimer', '{group_name}')).toEqual(['group_name']);
    expect(unknownPlaceholders('score_explanation', 'no tokens')).toEqual([]);
  });
});

describe('fillPlaceholders', () => {
  it('fills every occurrence', () => {
    expect(fillPlaceholders('{analyte_name}: {value} {unit} ({analyte_name})', { analyte_name: 'Hemoglobin', value: '9.1', unit: 'g/dL' }))
      .toBe('Hemoglobin: 9.1 g/dL (Hemoglobin)');
  });
  it('text without placeholders is returned unchanged', () => {
    expect(fillPlaceholders('plain', {})).toBe('plain');
  });
  it('throws when a used placeholder has no value (never silently emits "{x}" or "undefined")', () => {
    expect(() => fillPlaceholders('{analyte_name} {unit}', { analyte_name: 'Hemoglobin' })).toThrow();
  });
  it('SECURITY: single pass — a value containing a placeholder token is not re-expanded', () => {
    expect(fillPlaceholders('{analyte_name} / {unit}', { analyte_name: '{unit}', unit: 'g/dL' })).toBe('{unit} / g/dL');
  });
  it('SECURITY: replacement-pattern characters in values stay literal ($&, $1, $$)', () => {
    expect(fillPlaceholders('[{value}]', { value: "$& $1 $$ $'" })).toBe("[$& $1 $$ $']");
  });
  it('SECURITY: value is inserted verbatim (no HTML escaping, no trimming here)', () => {
    expect(fillPlaceholders('{value}', { value: ' <b> ' })).toBe(' <b> ');
  });
});

describe('refRangeText (§4.9 ref_range rule)', () => {
  it('snapshot text wins', () => {
    expect(refRangeText({ text: 'Negative', low: '1', high: '2' })).toBe('Negative');
  });
  it('low and high -> "<low> – <high>" (en dash, spaced)', () => {
    expect(refRangeText({ low: '13.5', high: '17.5' })).toBe('13.5 – 17.5');
  });
  it('high only -> "< <high>"', () => {
    expect(refRangeText({ high: '5.7' })).toBe('< 5.7');
  });
  it('low only -> "> <low>"', () => {
    expect(refRangeText({ low: '40' })).toBe('> 40');
  });
  it('nothing usable -> undefined', () => {
    expect(refRangeText({})).toBeUndefined();
  });
});

describe('derangedPlaceholderValues', () => {
  const base = {
    analyte: { name: 'HGB', printName: 'Hemoglobin' },
    result: { valueNumeric: '9.10', unitCode: 'g/dL' },
    referenceRangeSnapshot: { low: '13.5', high: '17.5' },
    groupName: 'Blood counts',
  };
  it('AC-10.1: analyte_name = printName; value/unit verbatim; ref_range; group_name', () => {
    expect(derangedPlaceholderValues(base as never)).toMatchObject({
      analyte_name: 'Hemoglobin', value: '9.10', unit: 'g/dL', ref_range: '13.5 – 17.5', group_name: 'Blood counts',
    });
  });
  it('analyte_name falls back to name when printName is absent', () => {
    expect(derangedPlaceholderValues({ ...base, analyte: { name: 'HGB' } } as never).analyte_name).toBe('HGB');
  });
  it('value precedence valueNumeric > valueText > ordinalCode', () => {
    const v = (result: object) => derangedPlaceholderValues({ ...base, result } as never).value;
    expect(v({ valueNumeric: '1.0', valueText: 'x', ordinalCode: 'POS' })).toBe('1.0');
    expect(v({ valueText: 'trace', ordinalCode: 'POS' })).toBe('trace');
    expect(v({ ordinalCode: 'POS' })).toBe('POS');
  });
});
