// C6-T02 flags.ts (02-TRD §4.4 table; AC-02.7). Pure.
// Assumed API: formatFlag(flag|undefined, {printCriticalLabel?}) -> {flagLabel?, valueBold}; methodLine(methodName?); formatRefRange({text?,low?,high?}).
import { describe, expect, it } from 'vitest';
import { formatFlag, formatRefRange, methodLine } from '../flags.js';

describe('formatFlag (§4.4)', () => {
  it('N and absent -> no label, not bold', () => {
    expect(formatFlag('N')).toEqual({ valueBold: false });
    expect(formatFlag(undefined)).toEqual({ valueBold: false });
  });
  it('H -> High bold (AC-02.7); L -> Low bold; A -> Abnormal bold', () => {
    expect(formatFlag('H')).toEqual({ flagLabel: 'High', valueBold: true });
    expect(formatFlag('L')).toEqual({ flagLabel: 'Low', valueBold: true });
    expect(formatFlag('A')).toEqual({ flagLabel: 'Abnormal', valueBold: true });
  });
  it('HH/LL print High/Low by default', () => {
    expect(formatFlag('HH')).toEqual({ flagLabel: 'High', valueBold: true });
    expect(formatFlag('LL')).toEqual({ flagLabel: 'Low', valueBold: true });
    expect(formatFlag('HH', { printCriticalLabel: false })).toEqual({ flagLabel: 'High', valueBold: true });
  });
  it('HH/LL print Critical High/Low when print_critical_label = true', () => {
    expect(formatFlag('HH', { printCriticalLabel: true })).toEqual({ flagLabel: 'Critical High', valueBold: true });
    expect(formatFlag('LL', { printCriticalLabel: true })).toEqual({ flagLabel: 'Critical Low', valueBold: true });
  });
  it('print_critical_label does not touch H/L/A/N', () => {
    expect(formatFlag('H', { printCriticalLabel: true }).flagLabel).toBe('High');
    expect(formatFlag('N', { printCriticalLabel: true })).toEqual({ valueBold: false });
  });
});

describe('methodLine (AC-02.7)', () => {
  it('prefixes "METHOD : "', () => {
    expect(methodLine('Synthetic Method X')).toBe('METHOD : Synthetic Method X');
  });
  it('absent or blank method -> no line', () => {
    expect(methodLine(undefined)).toBeUndefined();
    expect(methodLine('')).toBeUndefined();
    expect(methodLine('   ')).toBeUndefined();
  });
});

describe('formatRefRange (§4.4)', () => {
  it('snapshot text wins', () => {
    expect(formatRefRange({ text: 'Negative', low: '1', high: '2' })).toBe('Negative');
  });
  it('low and high -> "low – high" (en dash)', () => {
    expect(formatRefRange({ low: '13.0', high: '17.0' })).toBe('13.0 – 17.0');
  });
  it('only high -> "< high"; only low -> "> low"', () => {
    expect(formatRefRange({ high: '200' })).toBe('< 200');
    expect(formatRefRange({ low: '40' })).toBe('> 40');
  });
  it('nothing -> undefined', () => {
    expect(formatRefRange({})).toBeUndefined();
  });
});
