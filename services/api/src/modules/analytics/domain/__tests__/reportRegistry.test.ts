// AN-T02 domain/reportRegistry.ts (02-TRD §3.3 registry table + scheduled-report recipient permission note; D-44/B13; PRD US-17, US-18.1/18.6).
// Assumed API (pure, frozen data):
//   REPORT_REGISTRY: Readonly<Record<ReportCode, ReportDef>>
//   ReportDef = { code, permission: AnalyticsPermission (gate), families: readonly Family[], liveSources: readonly string[],
//                 exportable: boolean, schedulable: boolean, flag?: string, exportColumns: readonly string[] }
//   REPORT_CODES: readonly ReportCode[]                   — table order
//   getReport(code: string): ReportDef                    — unknown (incl. prototype keys) -> LimsError analytics.report_unknown (404)
//   SCHEDULE_REQUIRED_PERMISSION = 'analytics.dashboard.read'   — recipient requiredPermission for EVERY pack (08 A7.6)
import { describe, expect, it } from 'vitest';
import { ANALYTICS_PERMISSIONS } from '../../permissions.js';
import { FAMILIES } from '../families.js';
import { REPORT_CODES, REPORT_REGISTRY, SCHEDULE_REQUIRED_PERMISSION, getReport } from '../reportRegistry.js';
import { expectLims } from './helpers.js';

const DASH = 'analytics.dashboard.read';
const EXPECTED: Record<string, { permission: string; families: string[]; live: string[]; schedulable: boolean; flag?: string }> = {
  dashboard: { permission: DASH, families: ['orders', 'centre_volume', 'income', 'collections', 'results', 'report_backlog'], live: ['pending_items'], schedulable: true },
  income: { permission: DASH, families: ['income'], live: [], schedulable: true },
  department_income: { permission: DASH, families: ['department_income'], live: [], schedulable: true },
  collections: { permission: 'analytics.collections.read', families: ['collections'], live: [], schedulable: true },
  volume: { permission: DASH, families: ['orders', 'centre_volume'], live: [], schedulable: true },
  top_referrers: { permission: DASH, families: ['referrer_volume'], live: [], schedulable: true },
  top_centres: { permission: DASH, families: ['centre_volume', 'income'], live: [], schedulable: true },
  referral_incentive: { permission: 'analytics.referral_report.read', families: ['referrer_volume', 'referrer_billing'], live: [], schedulable: true, flag: 'referralIncentiveReportEnabled' },
  tests_done: { permission: DASH, families: ['results'], live: [], schedulable: true },
  tat: { permission: DASH, families: ['tat'], live: [], schedulable: true },
  pending_tests: { permission: DASH, families: ['report_backlog'], live: ['pending_items'], schedulable: true },
  quality_indicators: { permission: DASH, families: ['rejections', 'specimens', 'critical_values'], live: [], schedulable: true },
  delivery: { permission: DASH, families: ['deliveries', 'releases'], live: [], schedulable: true },
  interfaces: { permission: DASH, families: ['interface_messages'], live: ['agent_status'], schedulable: false },
};
const sorted = (xs: readonly string[]) => [...xs].sort();

describe('registry table (TRD §3.3)', () => {
  it('exactly the 14 report codes of the g_cs_report_codes seed, in table order', () => {
    expect([...REPORT_CODES]).toEqual(Object.keys(EXPECTED));
    expect(Object.keys(REPORT_REGISTRY)).toEqual(Object.keys(EXPECTED));
  });
  it.each(Object.entries(EXPECTED))('%s: permission, families, live sources, schedulable, flag', (code, want) => {
    const r = getReport(code);
    expect(r.code).toBe(code);
    expect(r.permission).toBe(want.permission);
    expect(sorted(r.families)).toEqual(sorted(want.families));
    expect(sorted(r.liveSources)).toEqual(sorted(want.live));
    expect(r.schedulable).toBe(want.schedulable);
    expect(r.exportable).toBe(true); // every report is exportable
    expect(r.flag).toBe(want.flag);
  });
  it('only referral_incentive is behind a tenant flag', () => {
    expect(REPORT_CODES.filter((c) => getReport(c).flag !== undefined)).toEqual(['referral_incentive']);
  });
  it('code format matches the schema CHECK (^[a-z_]{2,40}$) and none mentions "commission" (04 L19)', () => {
    for (const c of REPORT_CODES) {
      expect(c).toMatch(/^[a-z_]{2,40}$/);
      expect(c).not.toMatch(/commission/i);
    }
  });
});

describe('permissions are real C8 permission codes (IC §11); no invented names', () => {
  it('every gate permission is one of the 5 analytics.* codes', () => {
    for (const c of REPORT_CODES) expect(ANALYTICS_PERMISSIONS).toContain(getReport(c).permission);
  });
  it('analytics.data.export and analytics.schedule.manage gate actions, not reports', () => {
    for (const c of REPORT_CODES) expect(['analytics.data.export', 'analytics.schedule.manage']).not.toContain(getReport(c).permission);
  });
  it('privileged referral permission is used by referral_incentive and by nothing else', () => {
    expect(REPORT_CODES.filter((c) => getReport(c).permission === 'analytics.referral_report.read')).toEqual(['referral_incentive']);
  });
  it('collections permission gates only the collections report (CR-C8-001)', () => {
    expect(REPORT_CODES.filter((c) => getReport(c).permission === 'analytics.collections.read')).toEqual(['collections']);
  });
});

describe('D-44 / B13: per-referrer money is served only by referral_incentive', () => {
  it('top_referrers family set is exactly [referrer_volume] (volume only)', () => {
    expect([...getReport('top_referrers').families]).toEqual(['referrer_volume']);
  });
  it('referrer_billing (M33 net billed) appears in no report except referral_incentive', () => {
    expect(REPORT_CODES.filter((c) => getReport(c).families.includes('referrer_billing' as never))).toEqual(['referral_incentive']);
  });
  it('no export column of any other report carries per-referrer net billed or a commission', () => {
    for (const c of REPORT_CODES.filter((x) => x !== 'referral_incentive')) {
      for (const col of getReport(c).exportColumns) expect(col, `${c}.${col}`).not.toMatch(/net_billed|commission|incentive/i);
    }
  });
  it('top_referrers export has no money column at all', () => {
    for (const col of getReport('top_referrers').exportColumns) expect(col).not.toMatch(/paisa|amount|billed|income|sales/i);
  });
  it('referral_incentive exports the net billed figure (it is the one place it lives)', () => {
    expect(getReport('referral_incentive').exportColumns).toContain('net_billed_paisa');
  });
});

describe('export columns', () => {
  it('every report has a non-empty, duplicate-free list of snake_case wire names', () => {
    for (const c of REPORT_CODES) {
      const cols = getReport(c).exportColumns;
      expect(cols.length, c).toBeGreaterThan(0);
      expect(new Set(cols).size, c).toBe(cols.length);
      for (const col of cols) expect(col, `${c}.${col}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
  it('pending_tests export carries no patient identifier (US-10.3 / US-17.2)', () => {
    for (const col of getReport('pending_tests').exportColumns) {
      expect(col, col).not.toMatch(/patient|name|mrn|reg(istration)?_?no|barcode|phone|mobile|dob|birth|address|result|order_id|accession/i);
    }
  });
});

describe('US-18.1 scheduled-report recipient permission (08 A7.6)', () => {
  it('requiredPermission is analytics.dashboard.read for every pack, whatever its reports', () => {
    expect(SCHEDULE_REQUIRED_PERMISSION).toBe('analytics.dashboard.read');
  });
});

describe('lookup', () => {
  it('unknown code -> 404 analytics.report_unknown', () => {
    expectLims(() => getReport('nope'), 'analytics.report_unknown', 404);
  });
  it('near-misses and hostile values are unknown too (exact, case-sensitive, no trimming)', () => {
    for (const bad of ['', 'Dashboard', 'income ', ' income', 'top-referrers', 'referral_incentive;', '../income', 'income\n']) {
      expectLims(() => getReport(bad), 'analytics.report_unknown', 404);
    }
  });
  it('Object.prototype keys are not reports', () => {
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expectLims(() => getReport(bad), 'analytics.report_unknown', 404);
    }
  });
  it('non-string input -> report_unknown, not a TypeError', () => {
    for (const bad of [undefined, null, 7, {}, ['income']]) expectLims(() => getReport(bad as unknown as string), 'analytics.report_unknown', 404);
  });
});

describe('immutability and consistency', () => {
  it('registry, entries and their arrays are frozen', () => {
    expect(Object.isFrozen(REPORT_REGISTRY)).toBe(true);
    expect(Object.isFrozen(REPORT_CODES)).toBe(true);
    for (const c of REPORT_CODES) {
      const r = getReport(c);
      expect(Object.isFrozen(r), c).toBe(true);
      expect(Object.isFrozen(r.families), c).toBe(true);
      expect(Object.isFrozen(r.exportColumns), c).toBe(true);
    }
  });
  it('every referenced family exists and no family is referenced twice within one report', () => {
    for (const c of REPORT_CODES) {
      const f = getReport(c).families;
      expect(new Set(f).size).toBe(f.length);
      for (const x of f) expect(FAMILIES).toContain(x);
    }
  });
  it('interfaces is the only report that cannot be scheduled', () => {
    expect(REPORT_CODES.filter((c) => !getReport(c).schedulable)).toEqual(['interfaces']);
  });
});
