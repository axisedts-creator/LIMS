// T0D-NAV-COMPLETE-1: build-nav validation over ALL manifests with the new entries and the additive routes.yaml rows (04-UI-UX s3, AC-0D-7.5).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildNav } from '../build-nav.ts';
import { FEATURES, WEB, ROUTES_YAML, routes } from './nav-complete.helpers.ts';

describe('build-nav over every manifest', () => {
  it('library check: no errors (unique ids and chords, routes exist, staff_web, non-parameterised, permission equals the route\'s)', async () => {
    const { errors } = await buildNav(FEATURES, ROUTES_YAML);
    expect(errors).toEqual([]);
  });

  it('the three new manifests are picked up (lab, engagement, payments) and frontdesk is no longer empty', async () => {
    const { entries } = await buildNav(FEATURES, ROUTES_YAML);
    const by = (m: string) => entries.filter((e) => e.module === m).length;
    expect(by('frontdesk')).toBeGreaterThanOrEqual(3); // registration, worklist, discount approvals (settings page does not exist -> CR)
    expect(by('billing')).toBeGreaterThanOrEqual(9);
    expect(by('lab')).toBeGreaterThanOrEqual(10);
    expect(by('engagement')).toBeGreaterThanOrEqual(8);
    expect(by('payments')).toBe(5);
  });

  it('CLI exits 0 (this is what `pnpm -s verify` runs through build:nav)', () => {
    const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
    expect(r.status, `${r.stderr}${r.stdout}`).toBe(0);
  });

  it('additive routes only: every route added for these manifests is a unique staff_web row with a permission and an owner; ids and paths stay unique', () => {
    const ids = routes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const staff = routes.filter((r) => r.origin === 'staff_web');
    const paths = staff.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of staff.filter((x) => /^\/(frontdesk|billing|lab|engagement|payments|catalog\/tests)(\/|$)/.test(x.path))) {
      expect(r.permission, r.id).toBeTruthy();
      expect(r.owner, r.id).toMatch(/^C\d+$/);
    }
  });

  it('existing routes keep their path and permission (no route path or permission change)', () => {
    const keep: [string, string, string][] = [
      ['staff.frontdesk.registration_new', '/frontdesk/registrations/new', 'frontdesk.registration.create'],
      ['staff.billing.daily_cash', '/billing/daily-cash', 'billing.cash_report.read'],
      ['staff.lab.status_board', '/lab/status-board', 'lab.status_board.read'],
      ['staff.lab.ingest_exceptions', '/lab/ingest-exceptions', 'lab.result.read'],
      ['staff.catalog.test', '/catalog/tests/{test_id}', 'catalog.test.read'],
      ['staff.payments.review', '/payments/review', 'payments.reconciliation.read'],
      ['staff.engagement.queue', '/engagement/queue', 'engagement.queue.operate'],
    ];
    for (const [id, path, permission] of keep) {
      const r = routes.find((x) => x.id === id);
      expect([r?.path, r?.permission], id).toEqual([path, permission]);
    }
  });
});
