// AN-T02 domain/families.ts (02-TRD §9.1 families table; §8.2 event -> families dirtied). Pure.
// Assumed API:
//   FAMILIES: readonly Family[]                      — the 16 rollup families, in §9.1 order
//   FAMILY_TABLE: Readonly<Record<Family, string>>   — target table in schema `analytics` (§9.1)
//   SNAPSHOT_DATE = '1970-01-01'; isSnapshotFamily(f): boolean   — report_backlog is a whole-snapshot family (sentinel date, §8.2)
//   familiesDirtiedBy(eventType: string, payload?: { to_status?: string }): readonly Family[]   — set semantics (unique); unknown event -> []
//   CONSUMED_EVENTS: readonly string[]               — the 12 events of IC §3.25 that C8 consumes
import { describe, expect, it } from 'vitest';
import { CONSUMED_EVENTS, FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, familiesDirtiedBy, isSnapshotFamily } from '../families.js';
import { REPORT_REGISTRY } from '../reportRegistry.js';

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('family enum and table map (TRD §9.1)', () => {
  it('exactly the 16 families, in table order', () => {
    expect([...FAMILIES]).toEqual([
      'orders', 'centre_volume', 'referrer_volume', 'income', 'department_income', 'collections', 'referrer_billing', 'results',
      'specimens', 'rejections', 'critical_values', 'tat', 'releases', 'deliveries', 'interface_messages', 'report_backlog',
    ]);
  });
  it('family -> target table', () => {
    expect({ ...FAMILY_TABLE }).toEqual({
      orders: 'daily_orders', centre_volume: 'daily_centre_volume', referrer_volume: 'daily_referrer_volume', income: 'daily_income',
      department_income: 'daily_department_income', collections: 'daily_collections', referrer_billing: 'daily_referrer_billing',
      results: 'daily_results', specimens: 'daily_specimens', rejections: 'daily_rejections', critical_values: 'daily_critical_values',
      tat: 'tat_facts', releases: 'daily_releases', deliveries: 'daily_deliveries', interface_messages: 'daily_interface_messages',
      report_backlog: 'report_backlog',
    });
  });
  it('table names are safe SQL identifiers (they are interpolated into partition-replace SQL)', () => {
    for (const t of Object.values(FAMILY_TABLE)) expect(t).toMatch(/^[a-z][a-z0-9_]{2,62}$/);
  });
  it('every family listed by the report registry is a known family', () => {
    for (const def of Object.values(REPORT_REGISTRY)) for (const f of def.families) expect(FAMILIES).toContain(f);
  });
  it('report_backlog is the only snapshot family; sentinel date 1970-01-01', () => {
    expect(SNAPSHOT_DATE).toBe('1970-01-01');
    expect(FAMILIES.filter(isSnapshotFamily)).toEqual(['report_backlog']);
  });
  it('collections is a family although no event dirties it (swept every 10 min: payments emit no C8 event, PRD §8.5)', () => {
    expect(FAMILIES).toContain('collections');
    for (const e of CONSUMED_EVENTS) expect(familiesDirtiedBy(e, { to_status: 'received' })).not.toContain('collections');
  });
  it('is immutable', () => {
    expect(Object.isFrozen(FAMILIES)).toBe(true);
    expect(Object.isFrozen(FAMILY_TABLE)).toBe(true);
  });
});

describe('event -> families dirtied (TRD §8.2 table)', () => {
  const order = ['orders', 'centre_volume', 'referrer_volume', 'report_backlog'];
  const invoice = ['income', 'department_income', 'referrer_billing'];
  const table: Array<[string, Record<string, unknown> | undefined, string[]]> = [
    ['frontdesk.order.created.v1', undefined, order],
    ['frontdesk.order.cancelled.v1', undefined, order],
    ['billing.invoice.issued.v1', undefined, invoice],
    ['billing.invoice.cancelled.v1', undefined, invoice],
    ['lab.result.verified.v1', undefined, ['results', 'tat']],
    ['lab.result.approved.v1', undefined, ['results', 'report_backlog']],
    ['lab.result.amended.v1', undefined, ['results']],
    ['lab.critical_value.detected.v1', undefined, ['critical_values', 'results']],
    ['instruments.agent.health_changed.v1', undefined, ['interface_messages']],
    ['reporting.report.released.v1', undefined, ['releases', 'tat', 'report_backlog']],
    ['reporting.delivery.status_changed.v1', undefined, ['deliveries']],
  ];
  it.each(table)('%s', (event, payload, want) => {
    expect(sorted(familiesDirtiedBy(event, payload as never))).toEqual(sorted(want));
  });

  describe('lab.specimen.status_changed.v1 depends on to_status', () => {
    const E = 'lab.specimen.status_changed.v1';
    const cases: Array<[string | undefined, string[]]> = [
      ['received', ['specimens', 'tat', 'report_backlog']],
      ['verified', ['specimens', 'tat', 'report_backlog']],
      ['rejected', ['specimens', 'tat', 'rejections', 'report_backlog']],
      ['recollection_ordered', ['specimens', 'rejections', 'report_backlog']],
      ['collected', ['specimens', 'report_backlog']],
      ['in_transit', ['specimens', 'report_backlog']],
      ['discarded', ['specimens', 'report_backlog']],
      [undefined, ['specimens', 'report_backlog']],
    ];
    it.each(cases)('to_status=%s', (to, want) => {
      expect(sorted(familiesDirtiedBy(E, to === undefined ? {} : { to_status: to }))).toEqual(sorted(want));
    });
    it('also works with no payload at all, and an unexpected to_status does not add tat/rejections', () => {
      expect(sorted(familiesDirtiedBy(E))).toEqual(['report_backlog', 'specimens']);
      expect(sorted(familiesDirtiedBy(E, { to_status: 'RECEIVED; DROP' }))).toEqual(['report_backlog', 'specimens']);
    });
  });

  it('unknown or look-alike events dirty nothing (and never throw)', () => {
    for (const e of ['', 'frontdesk.order.created', 'frontdesk.order.created.v2', 'billing.payment.recorded.v1', 'constructor', '__proto__', 'toString']) {
      expect(familiesDirtiedBy(e)).toEqual([]);
    }
  });
  it('results are unique and known families', () => {
    for (const e of CONSUMED_EVENTS) {
      const a = familiesDirtiedBy(e, { to_status: 'rejected' });
      expect(new Set(a).size).toBe(a.length);
      for (const f of a) expect(FAMILIES).toContain(f);
    }
  });
  it('CONSUMED_EVENTS is the 12 events of the table above (11 fixed + specimen status)', () => {
    expect(CONSUMED_EVENTS).toHaveLength(12);
    expect(new Set(CONSUMED_EVENTS)).toEqual(new Set([...table.map((t) => t[0]), 'lab.specimen.status_changed.v1']));
    for (const e of CONSUMED_EVENTS) expect(e).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+\.v1$/);
  });
  it('every event dirties at least one family', () => {
    for (const e of CONSUMED_EVENTS) expect(familiesDirtiedBy(e, { to_status: 'received' }).length).toBeGreaterThan(0);
  });
});
