// C3 T-18 — tax domain rules (domain/tax.ts). Spec: 02-TRD §7.6 (rules effective at `at`: orderable rule > department rule > tenant default; department used for a test = the test's department;
// for a panel/package = orderables.department_id if set, else NO department rule applies; no tenant default -> catalog.tax_config_missing is the caller's job: the picker returns undefined),
// §7.6a steps 3-5 (VAT = global row, effectiveFrom null; other codes = the cs_tax_types version of that code with is_active and effective_from <= t < coalesce(effective_to, +inf) and rate_bp
// NOT NULL — a type without a rate is unusable), 01-PRD AC-15.1 (orderable `taxable` beats tenant-default `exempt`; vatRateBp 1300), AC-15.2 (tax type with no rate unusable), AC-15.3 (no
// tenant default = no answer, C3 never assumes "exempt"), 08 R18 (rates are effective-dated; a change = a new version row), 04 L14 (VAT 13 % = 1300 bp).
// Interface expected from the writer — SEAMS:
//   export const VAT_RATE_BP_DEFAULT?  (not required)  — the rate itself comes from the g_tax_types row, never a constant in the domain.
//   export function pickTaxRule<R>(rules: readonly R[], q: { orderableId: string; departmentId?: string|null; at: Date|string }): R | undefined
//   export function taxTypeVersionAt<V>(versions: readonly V[], code: string, at: Date|string): V | undefined      // the version of `code` effective at `at` (active, window) — rate may be null
//   export function isTaxTypeUsable(version: { rate_bp?: number|null; is_active?: boolean } | undefined): boolean    // exists, active and rate_bp != null
//   export function vatRateBp(treatment: 'exempt'|'taxable', globalVatRateBp: number): number | undefined            // taxable -> the rate; exempt -> undefined
import { describe, expect, it } from 'vitest';
import { isTaxTypeUsable, pickTaxRule, taxTypeVersionAt, vatRateBp } from '../tax.js';

const D1 = '0190c300-0000-7000-8000-000000000101';
const D2 = '0190c300-0000-7000-8000-000000000102';
const O1 = '0190c300-0000-7000-8000-000000001001';
const O2 = '0190c300-0000-7000-8000-000000001002';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
const T2 = '2026-12-01T00:00:00.000Z';
const AT = new Date('2026-07-01T00:00:00Z');

describe('pickTaxRule: orderable > department > tenant default (02-TRD §7.6; AC-15.1, AC-15.3)', () => {
  const rule = (id: string, o: Record<string, unknown> = {}) => ({ id, scope: 'tenant_default', department_id: null, orderable_id: null, vat_treatment: 'exempt', effective_from: T0, effective_to: null, is_active: true, ...o });
  const DEF = rule('def');
  const DEPT = rule('dept', { scope: 'department', department_id: D1, vat_treatment: 'taxable' });
  const ORD = rule('ord', { scope: 'orderable', orderable_id: O1, vat_treatment: 'taxable' });
  const id = (r: { id: string } | undefined) => r?.id;
  const q = (o: Record<string, unknown> = {}) => ({ orderableId: O1, departmentId: D1, at: AT, ...o });

  it('AC-15.1: the orderable rule wins over the department rule and the tenant default', () => {
    expect(id(pickTaxRule([DEF, DEPT, ORD], q()))).toBe('ord');
    expect(pickTaxRule([DEF, DEPT, ORD], q())).toMatchObject({ vat_treatment: 'taxable' });
  });
  it('AC-15.1: every other orderable gets the tenant default', () => {
    expect(id(pickTaxRule([DEF, ORD], q({ orderableId: O2, departmentId: null })))).toBe('def');
    expect(pickTaxRule([DEF, ORD], q({ orderableId: O2, departmentId: null }))).toMatchObject({ vat_treatment: 'exempt' });
  });
  it('department rule beats the tenant default; only for the orderable\'s own department', () => {
    expect(id(pickTaxRule([DEF, DEPT], q({ orderableId: O2 })))).toBe('dept');
    expect(id(pickTaxRule([DEF, DEPT], q({ orderableId: O2, departmentId: D2 })))).toBe('def');
  });
  it('§7.6: a panel/package without a department gets NO department rule (falls to the tenant default)', () => {
    expect(id(pickTaxRule([DEF, DEPT], q({ orderableId: O2, departmentId: null })))).toBe('def');
    expect(id(pickTaxRule([DEF, DEPT], q({ orderableId: O2, departmentId: undefined })))).toBe('def');
  });
  it('the result does not depend on the input order', () => {
    for (const perm of [[DEF, DEPT, ORD], [ORD, DEPT, DEF], [DEPT, DEF, ORD]]) expect(id(pickTaxRule(perm, q()))).toBe('ord');
  });
  it('AC-15.3: no tenant default (and nothing more specific) -> undefined; never an assumed "exempt"', () => {
    expect(pickTaxRule([], q())).toBeUndefined();
    expect(pickTaxRule([DEPT], q({ departmentId: D2, orderableId: O2 }))).toBeUndefined();
    expect(pickTaxRule([ORD], q({ orderableId: O2, departmentId: null }))).toBeUndefined();
  });
  it('windows are half-open [from, to); a rule not yet effective or already ended is ignored', () => {
    const w = rule('w', { effective_from: T1, effective_to: T2 });
    expect(pickTaxRule([w], q({ at: new Date('2026-05-31T23:59:59.999Z') }))).toBeUndefined();
    expect(id(pickTaxRule([w], q({ at: T1 })))).toBe('w');
    expect(pickTaxRule([w], q({ at: T2 }))).toBeUndefined();
  });
  it('AC-15.5 successor chain: at the switch instant the NEW default applies, just before it the old one', () => {
    const old = rule('old', { effective_from: T0, effective_to: T1, vat_treatment: 'exempt' });
    const next = rule('new', { effective_from: T1, effective_to: null, vat_treatment: 'taxable' });
    expect(id(pickTaxRule([old, next], q({ at: new Date('2026-05-31T23:59:59.999Z'), orderableId: O2, departmentId: null })))).toBe('old');
    expect(id(pickTaxRule([old, next], q({ at: T1, orderableId: O2, departmentId: null })))).toBe('new');
  });
  it('an inactive rule is ignored', () => {
    expect(pickTaxRule([rule('off', { scope: 'orderable', orderable_id: O1, is_active: false })], q())).toBeUndefined();
  });
  it('does not mutate its input', () => {
    const rules = [DEF, DEPT, ORD]; const copy = JSON.stringify(rules);
    pickTaxRule(rules, q());
    expect(JSON.stringify(rules)).toBe(copy);
  });
});

describe('taxTypeVersionAt / isTaxTypeUsable: effective-dated rates, a type without a rate is unusable (AC-15.2; 08 R18; §7.6a)', () => {
  const v = (id: string, code: string, o: Record<string, unknown> = {}) => ({ id, code, rate_bp: 500, effective_from: T0, effective_to: null, is_active: true, ...o });
  const hst1 = v('hst1', 'HST', { effective_from: T0, effective_to: T1, rate_bp: 500 });
  const hst2 = v('hst2', 'HST', { effective_from: T1, effective_to: null, rate_bp: 750 });
  const edu = v('edu', 'EDU', { rate_bp: null });

  it('picks the version of the code effective at `at` (rate history)', () => {
    expect(taxTypeVersionAt([hst1, hst2, edu], 'HST', new Date('2026-03-01T00:00:00Z'))).toMatchObject({ id: 'hst1', rate_bp: 500 });
    expect(taxTypeVersionAt([hst1, hst2, edu], 'HST', AT)).toMatchObject({ id: 'hst2', rate_bp: 750 });
  });
  it('boundary: at the successor\'s effective_from the NEW rate applies (half-open); one ms earlier the old one', () => {
    expect(taxTypeVersionAt([hst1, hst2], 'HST', new Date('2026-05-31T23:59:59.999Z'))).toMatchObject({ id: 'hst1' });
    expect(taxTypeVersionAt([hst1, hst2], 'HST', T1)).toMatchObject({ id: 'hst2' });
  });
  it('before the first version, or for an unknown code -> undefined', () => {
    expect(taxTypeVersionAt([hst1, hst2], 'HST', new Date('2025-12-31T23:59:59Z'))).toBeUndefined();
    expect(taxTypeVersionAt([hst1, hst2], 'NOPE', AT)).toBeUndefined();
  });
  it('a scheduled (future) version is not picked until its effective_from', () => {
    const current = { ...hst2, effective_to: T2 };
    const future = v('f', 'HST', { effective_from: T2, rate_bp: 900 });
    expect(taxTypeVersionAt([current, future], 'HST', AT)).toMatchObject({ id: 'hst2' });
    expect(taxTypeVersionAt([current, future], 'HST', T2)).toMatchObject({ id: 'f' });
  });
  it('an inactive version is never picked', () => {
    expect(taxTypeVersionAt([v('x', 'HST', { is_active: false })], 'HST', AT)).toBeUndefined();
  });
  it('AC-15.2: a version with rate_bp null is found but not usable', () => {
    expect(taxTypeVersionAt([edu], 'EDU', AT)).toMatchObject({ code: 'EDU' });
    expect(isTaxTypeUsable(edu)).toBe(false);
    expect(isTaxTypeUsable({ rate_bp: undefined, is_active: true })).toBe(false);
  });
  it('rate 0 IS a rate (0 % is configured, not "missing")', () => {
    expect(isTaxTypeUsable(v('z', 'ZERO', { rate_bp: 0 }))).toBe(true);
  });
  it('usable = exists, active and a non-null rate', () => {
    expect(isTaxTypeUsable(hst2)).toBe(true);
    expect(isTaxTypeUsable(undefined)).toBe(false);
    expect(isTaxTypeUsable({ rate_bp: 500, is_active: false })).toBe(false);
  });
  it('code matching is exact (no case folding, no prefix match)', () => {
    expect(taxTypeVersionAt([hst2], 'hst', AT)).toBeUndefined();
    expect(taxTypeVersionAt([hst2], 'HS', AT)).toBeUndefined();
  });
});

describe('vatRateBp: 04 L14 — the rate comes from the global g_tax_types row; exempt has none', () => {
  it('taxable -> the global rate (1300 for the VAT row, AC-15.1)', () => { expect(vatRateBp('taxable', 1300)).toBe(1300); });
  it('taxable follows the row, not a constant', () => { expect(vatRateBp('taxable', 1500)).toBe(1500); });
  it('exempt -> undefined (no vatRateBp field)', () => { expect(vatRateBp('exempt', 1300)).toBeUndefined(); });
  it('rejects an unknown treatment', () => { expect(() => vatRateBp('zero_rated' as never, 1300)).toThrow(); });
});
