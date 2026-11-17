// T0B-MISREPORTS-1 registry / handler wiring (no database). done_when (1) "register handlers and report definitions for everything T0C-MISREPORTS-1 adds
// so the module boot check passes", LD-325 (a pending list is removed by the handler task), LD-342 / A39-3 (the word only in the two definitions).
// Pinned: the 11 definitions of x-report-definitions become registry rows AFTER the 14 old ones, in contract order; the registry never restates a permission
// or a column list (it follows the contract). T0C-MISREPORTS-1 adds no operation, so no pendingOperations entry exists and none may be added.
import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../../domain/families.js';
import { REPORT_CODES, getReport } from '../../domain/reportRegistry.js';
import { checkReportParams, isExportable } from '../../export/reportTable.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { OPS } from '../probes/spec.js';
import { DEFS, MONEY_CODES, NEW_CODES, OLD_CODES, PLAIN_CODES, def } from './contract.js';

const WORD = ['commis', 'sion'].join('');

describe('registry rows for the 11 MIS report definitions', () => {
  it('the contract defines exactly 11 new codes (guards the fixture itself)', () => {
    expect(NEW_CODES).toEqual(['bill_of_the_day', 'two_level_commission', 'sales_representative', 'consultant', 'collection_boy', 'repeated_patient', 'repeated_test', 'ipd_opd', 'tds', 'party_billing', 'outsource']);
  });
  it('REPORT_CODES = the 14 old codes unchanged and in order, then the new codes in contract order', () => {
    expect([...REPORT_CODES]).toEqual([...OLD_CODES, ...NEW_CODES]);
  });
  it.each(NEW_CODES)('%s: permission, flag, exportable, schedulable, columns come from the contract', (code) => {
    const d = def(code); const r = getReport(code);
    expect(r.code).toBe(code);
    expect(r.permission).toBe(d.permission);
    expect(r.flag).toBe(d.flag);
    expect(r.exportable).toBe(d.exportable);
    expect(r.schedulable).toBe(d.schedulable);
    expect([...r.exportColumns]).toEqual(d.columns.map((c) => c.name));
    for (const f of r.families) expect(FAMILIES).toContain(f);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it('the gate: flag referralIncentiveReportEnabled + analytics.referral_report.read for the two money reports, nobody else gets either', () => {
    for (const c of MONEY_CODES) { expect(getReport(c).flag).toBe('referralIncentiveReportEnabled'); expect(getReport(c).permission).toBe('analytics.referral_report.read'); }
    for (const c of PLAIN_CODES) { expect(getReport(c).flag, c).toBeUndefined(); expect(getReport(c).permission, c).not.toBe('analytics.referral_report.read'); }
  });
  it('no new permission code and no export/schedule permission used as a report gate', () => {
    for (const c of NEW_CODES) expect(['analytics.dashboard.read', 'analytics.collections.read', 'analytics.referral_report.read']).toContain(getReport(c).permission);
  });
  it('the word is in the registry for the two money reports only (code, columns); the ban holds for every other row', () => {
    for (const c of REPORT_CODES) {
      const hasWord = c.includes(WORD) || getReport(c).exportColumns.some((x) => x.includes(WORD));
      expect(hasWord, c).toBe((MONEY_CODES as readonly string[]).includes(c));
    }
  });
  it('per party money columns (rates, payable, TDS) appear only in the two money reports', () => {
    for (const c of REPORT_CODES.filter((x) => !(MONEY_CODES as readonly string[]).includes(x))) {
      for (const col of getReport(c).exportColumns) expect(col, `${c}.${col}`).not.toMatch(/commission|tds|payable/i);
    }
  });
  it('two_level_commission and tds expose exactly the columns pinned by A39-1 (no pay / payout / status column)', () => {
    expect(getReport('two_level_commission').exportColumns).toEqual(expect.arrayContaining(['commission_bp', 'commission_paisa']));
    expect(getReport('tds').exportColumns).toEqual(expect.arrayContaining(['commission_payable_paisa', 'tds_bp', 'tds_withheld_paisa', 'net_payable_paisa']));
    for (const c of MONEY_CODES) for (const col of getReport(c).exportColumns) expect(col, `${c}.${col}`).not.toMatch(/pay_?out|paid|status|pay_now|bank|transfer/i);
  });
});

describe('export request validation knows every new report (reportTable SPECS)', () => {
  it.each(NEW_CODES)('%s is exportable and its contract example_params pass checkReportParams', (code) => {
    expect(isExportable(code)).toBe(true);
    expect(() => checkReportParams(code, def(code).example_params)).not.toThrow();
  });
  it.each(NEW_CODES)('%s: an unknown filter key is refused with the standard validation error', (code) => {
    let e: any;
    try { checkReportParams(code, { ...def(code).example_params, filters: { ...(def(code).example_params.filters ?? {}), no_such_filter: ['x'] } }); } catch (x) { e = x; }
    expect(e?.code).toBe('common.validation_failed');
  });
  it('a malformed uuid in a uuid filter is refused (no SQL ever sees it)', () => {
    let e: any;
    try { checkReportParams('party_billing', { business_date_from: '2020-06-01', business_date_to: '2020-06-30', filters: { party_id: ["'; DROP TABLE billing.invoices; --"] } }); } catch (x) { e = x; }
    expect(e?.code).toBe('common.validation_failed');
  });
});

describe('module wiring (LD-325): handlers == contract operations, no pending list, no new route', () => {
  it('the contract still has its 30 operations and every one has a handler', () => {
    expect(OPS).toHaveLength(30);
    expect(Object.keys(handlers).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
  it('no pendingOperations entry (the contract task added no operation; the handler task must not add one)', () => {
    const p = (manifest as { pendingOperations?: readonly string[] }).pendingOperations;
    expect(p === undefined || p.length === 0).toBe(true);
  });
  it('the definitions carry a row cap and a default sort on a declared column', () => {
    for (const d of DEFS) { expect(d.row_cap, d.code).toBeGreaterThan(0); expect(d.columns.map((c) => c.name), d.code).toContain(d.default_sort.column); }
  });
});
