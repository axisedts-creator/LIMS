// BL-T05 static guards on the service sources (08 R18: no C4 tax table, no guessed rate; computeQuote is pure; REQ-ARCH-076 no cross-module imports).
// Fails now: service/quote.service.ts and service/settings.service.ts do not exist.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SVC = join(import.meta.dirname, '..');
const OTHER_MODULES = /\/(identity|audit|catalog|frontdesk|lab|instruments|reporting|analytics|quality|micro|anatomic|inventory|partners|smartreport|payments|engagement|homecollection)\//;
const src = (f: string): string => {
  expect(existsSync(join(SVC, f)), `${f} must exist`).toBe(true);
  return readFileSync(join(SVC, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // code only, comments stripped
};

describe('quote.service.ts', () => {
  const s = () => src('quote.service.ts');
  it('hard-codes no tax rate (no 1300 / 13 % / 0.13 literal): the rate always comes from the line', () => {
    expect(s()).not.toMatch(/\b1300\b|\b0?\.13\b|\b13\s*\/\s*100\b|\b13\s*%/);
  });
  it('is pure: no tx/query/INSERT/UPDATE, no repository import, no event publish, no network', () => {
    const t = s();
    expect(t).not.toMatch(/\.query\s*\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|repository\/|\.publish\s*\(|\bfetch\s*\(/);
  });
  it('has no local tax table and does not read C3 tables (billing.tax_codes was removed, 08 R18)', () => {
    expect(s()).not.toMatch(/tax_codes|billing\.tax|catalog\.tax_rules|catalog\.cs_tax_types/i);
  });
  it('imports no other module folder', () => {
    for (const m of s().matchAll(/from\s+'([^']+)'/g)) expect(m[1], m[1]).not.toMatch(OTHER_MODULES);
  });
  it('reuses the BL-T02 pure domain (domain/money/tax) instead of re-implementing rounding', () => {
    expect(s()).toMatch(/domain\/money\/tax(\.js)?'/);
  });
});

describe('settings.service.ts', () => {
  it('builds SQL only through the repository layer and imports no other module folder', () => {
    const t = src('settings.service.ts');
    expect(t).not.toMatch(/\.query\s*\(|\bINSERT\b|\bUPDATE\b|\bSELECT\b/);
    for (const m of t.matchAll(/from\s+'([^']+)'/g)) expect(m[1], m[1]).not.toMatch(OTHER_MODULES);
  });
  it('knows no tax-rate settings (tax rules live in C3, 08 R18)', () => {
    expect(src('settings.service.ts')).not.toMatch(/vat_rate|tax_code|taxRate/i);
  });
});
