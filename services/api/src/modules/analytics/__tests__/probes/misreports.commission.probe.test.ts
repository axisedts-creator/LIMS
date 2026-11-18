// T0B-MISREPORTS-1 security probe (LD-342 / A39-6e; 07-SECURITY D-44 probe extended to the codes two_level_commission and tds). Generator-driven from analytics.yaml like the
// rest of the probe suite: with the flag off, the permission missing or aal1, no endpoint, export, schedule or dashboard card can return a commission_* or tds_* column,
// because no response schema of any operation DECLARES one: the only way to receive such a column is the export FILE of the two gated reports (refusals: misreports/gates.test.ts).
import { describe, expect, it } from 'vitest';
import { REPORT_CODES, getReport } from '../../domain/reportRegistry.js';
import { OPS, DOCS, declaredPaths, requestSchema, responseSchema } from './spec.js';

const WORD = ['commis', 'sion'].join('');
const MONEY_KEY = new RegExp(`${WORD}|(^|_)tds(_|$)|payable|payout`, 'i');
const lastKey = (p: string) => p.split(/[.[\]]+/).filter(Boolean).at(-1) ?? '';

describe('no operation declares a commission or TDS field (the two gated reports travel only inside the export file)', () => {
  it.each(OPS.map((o) => [o.id]))('%s: response key paths carry no commission_ / tds_ / payable / payout key', (id) => {
    const o = OPS.find((x) => x.id === id)!;
    const keys = [...declaredPaths(responseSchema(o))].map(lastKey).filter((k) => MONEY_KEY.test(k));
    expect(keys, `${id} response`).toEqual([]);
    for (const status of Object.keys(o.raw.responses ?? {})) {
      if (status === '200') continue;
      const s = responseSchema(o, status);
      if (s) expect([...declaredPaths(s)].map(lastKey).filter((k) => MONEY_KEY.test(k)), `${id} ${status}`).toEqual([]);
    }
  });
  it.each(OPS.filter((o) => o.hasBody).map((o) => [o.id]))('%s: request body declares no commission_ / tds_ key', (id) => {
    const keys = [...declaredPaths(requestSchema(OPS.find((x) => x.id === id)!))].map(lastKey).filter((k) => MONEY_KEY.test(k));
    expect(keys, id).toEqual([]);
  });
  it('the dashboard cards (tiles, series, department_top) hold no such key', () => {
    const o = OPS.find((x) => x.id === 'getAnalyticsDashboard')!;
    expect([...declaredPaths(responseSchema(o))].map(lastKey).filter((k) => MONEY_KEY.test(k))).toEqual([]);
  });
  it('no dashboard / export / schedule schema offers a pay, payout or bank action (reports only, no money moves: A39-1)', () => {
    expect(OPS.map((o) => o.id).filter((id) => /pay(out)?(?![a-z])|payout|disburse|transfer/i.test(id))).toEqual([]);
    expect(Object.keys(DOCS.analytics.paths).filter((p) => /pay|disburse|transfer|bank/i.test(p))).toEqual([]);
  });
});

describe('the registry never lets a money report out through another gate', () => {
  it('every report whose columns carry a commission_ / tds_ column is flag gated and uses analytics.referral_report.read', () => {
    for (const c of REPORT_CODES) {
      const r = getReport(c);
      if (r.exportColumns.some((col) => MONEY_KEY.test(col) && !/^net_billed|^orders/.test(col))) {
        expect(r.flag, c).toBe('referralIncentiveReportEnabled');
        expect(r.permission, c).toBe('analytics.referral_report.read');
      }
    }
  });
  it('the dashboard, income, department income, top referrers, referral incentive, freshness and refresh rows never list the word in a column (A39-6d)', () => {
    for (const c of ['dashboard', 'income', 'department_income', 'top_referrers', 'referral_incentive']) {
      for (const col of getReport(c).exportColumns) expect(col, `${c}.${col}`).not.toMatch(MONEY_KEY);
    }
  });
});
