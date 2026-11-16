// T0D-MSERIES-2 (LD-251; spec/program/13-M-SERIES.md s3; C0 04-UI-UX s3): the sidebar groups are the 14 NavGroups, no longer folded onto 8 headings,
// and build-nav.ts carries the two optional manifest fields the sidebar needs. CONTRACT chosen by the tester (writer: follow it or dispute in .orchestra/notes):
//   core/nav/rail-groups.ts  exports RAIL_GROUPS = the 14 NavGroups in 13 s3 order as { id: NavGroup; labelKey: 'core.nav.group.<id>' }; NO railGroupFor, no 8-heading map.
//   core/nav/types.ts        NavEntry gains optional `section?: string` (message key of the sub-heading) and `createRouteId?: RouteId` + `createLabel?: string` (message key of the round "+").
//                            ResolvedNavEntry gains optional `createPath?: string` and `createPermission?: string` (path and permission of the create route).
//   build-nav.ts             createRouteId must exist in routes.yaml, be origin staff_web, have no path parameters, and the entry must carry createLabel (the "+" needs a name); each violation is an error naming the entry id.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { t } from '../../i18n/messages.ts';
import { buildNav } from '../build-nav.ts';
import { NAV_GROUPS } from '../types.ts';
import * as mod from '../rail-groups.ts';
import { FEATURES, ROUTES_YAML, routes } from './nav-complete.helpers.ts';

const SPEC_ORDER = ['front_desk', 'laboratory', 'reporting', 'billing', 'catalog', 'instruments', 'analytics', 'quality', 'inventory', 'partners', 'engagement', 'home_collection', 'admin', 'platform'];
const LABELS = ['Front desk', 'Laboratory', 'Reporting', 'Billing', 'Catalog', 'Instruments', 'Analytics', 'Quality', 'Inventory', 'Partners', 'Engagement', 'Home collection', 'Admin', 'Platform'];

describe('RAIL_GROUPS = the 14 NavGroups (13 s3)', () => {
  const RAIL = (mod as any).RAIL_GROUPS as readonly { id: string; labelKey: string }[];
  it('are the 14 NavGroups of 04-UI-UX s3, in the order of 13 s3, platform last', () => {
    expect(RAIL.map((g) => g.id)).toEqual(SPEC_ORDER);
    expect([...NAV_GROUPS]).toEqual(SPEC_ORDER);
  });
  it('label keys are core.nav.group.<NavGroup>, unique, catalogued (never a raw key) and read as the spec names', () => {
    expect(RAIL.map((g) => g.labelKey)).toEqual(SPEC_ORDER.map((g) => `core.nav.group.${g}`));
    expect(RAIL.map((g) => t(g.labelKey))).toEqual(LABELS);
  });
  it('the 8-heading fold is gone: no railGroupFor, no map onto fewer headings', () => {
    expect((mod as any).railGroupFor).toBeUndefined();
    expect(Object.keys(mod).sort()).not.toContain('RailGroupId'); // type-only export would not show; the ids above are the check
  });
});

describe('build-nav.ts: section and create route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2-nav-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const yaml = [
    'routes:',
    '  - { id: staff.demo.list, origin: staff_web, path: /demo, owner: C0, permission: demo.read }',
    '  - { id: staff.demo.new, origin: staff_web, path: /demo/new, owner: C0, permission: demo.manage }',
    '  - { id: staff.demo.item, origin: staff_web, path: "/demo/{id}", owner: C0, permission: demo.read }',
    '  - { id: portal.demo.new, origin: portal, path: /p/demo/new, owner: C0, permission: demo.manage }',
  ].join('\n');
  const features = (name: string, entry: Record<string, unknown>) => {
    const f = join(dir, name);
    mkdirSync(join(f, 'demo'), { recursive: true });
    writeFileSync(join(f, 'demo', 'nav.manifest.ts'), `export const navManifest = { module: 'demo', entries: [${JSON.stringify({ id: 'demo.list', label: 'demo.nav.list', routeId: 'staff.demo.list', permission: 'demo.read', group: 'catalog', order: 10, ...entry })}] };\n`);
    return f;
  };

  it('carries section through and resolves the create route into createPath and createPermission', async () => {
    const { errors, entries } = await buildNav(features('ok', { section: 'demo.nav.section.x', createRouteId: 'staff.demo.new', createLabel: 'demo.nav.new' }), yaml);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ section: 'demo.nav.section.x', createLabel: 'demo.nav.new', createPath: '/demo/new', createPermission: 'demo.manage', path: '/demo' });
  });

  it('an entry without them is unchanged (no createPath, no section)', async () => {
    const { errors, entries } = await buildNav(features('plain', {}), yaml);
    expect(errors).toEqual([]);
    expect(entries[0]).not.toHaveProperty('createPath');
    expect(entries[0]).not.toHaveProperty('section');
  });

  it.each([
    ['an unknown create route', { createRouteId: 'staff.demo.nope', createLabel: 'x' }],
    ['a create route with path parameters', { createRouteId: 'staff.demo.item', createLabel: 'x' }],
    ['a create route that is not a staff_web route', { createRouteId: 'portal.demo.new', createLabel: 'x' }],
    ['a create route without a label for the "+"', { createRouteId: 'staff.demo.new' }],
  ])('fails the build on %s, naming the entry', async (_n, extra) => {
    const { errors } = await buildNav(features(`bad-${_n.replace(/\W+/g, '-')}`, extra), yaml);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('demo.list');
    expect(errors.join('\n')).toMatch(/create/i);
  });
});

const real = await buildNav(FEATURES, ROUTES_YAML);
describe('real manifests (T0D-NAV-COMPLETE-1 data + this task)', () => {
  const { errors, entries } = real;
  const sorted = (g: string) => entries.filter((e) => e.group === g).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  it('the build is clean', () => { expect(errors).toEqual([]); });

  it('Users declares the create route staff.admin.user_new (round "+": "Invite user"); createPath/createPermission come from routes.yaml', () => {
    const users = entries.find((e) => e.path === '/admin/users')!;
    expect(users).toBeTruthy();
    expect((users as any).createRouteId).toBe('staff.admin.user_new');
    expect((users as any).createPath).toBe('/admin/users/new');
    expect((users as any).createPermission).toBe('identity.user.manage');
    expect(t((users as any).createLabel)).toBe('Invite user');
  });

  it('Tests, Panels and Price lists declare a create route exactly when routes.yaml has one at <path>/new (13 s3: the "+" goes straight to the create screen)', () => {
    for (const p of ['/catalog/tests', '/catalog/panels', '/catalog/price-lists']) {
      const e = entries.find((x) => x.path === p)!;
      expect(e, p).toBeTruthy();
      const create = routes.find((r) => r.origin === 'staff_web' && r.path === `${p}/new`);
      expect(Boolean((e as any).createRouteId), p).toBe(Boolean(create));
    }
  });

  it('only entries with a create route carry createPath (no stray "+")', () => {
    for (const e of entries) expect(Boolean((e as any).createPath), e.id).toBe(Boolean((e as any).createRouteId));
  });

  it('sections of 13 s3: Laboratory (Daily work, Microbiology, Anatomic pathology), Reporting (Smart summaries), Billing (Payments), Catalog (Pricing)', () => {
    const sec = (e: any) => (e.section ? t(e.section) : undefined);
    const of = (g: string, pred: (e: any) => boolean) => sorted(g).filter(pred).map(sec);
    expect(of('laboratory', (e) => e.module === 'lab').every((s) => s === 'Daily work')).toBe(true);
    expect(of('laboratory', (e) => e.module === 'micro').every((s) => s === 'Microbiology')).toBe(true);
    expect(of('laboratory', (e) => e.module === 'anatomic').every((s) => s === 'Anatomic pathology')).toBe(true);
    expect(of('reporting', (e) => e.module === 'smartreport').every((s) => s === 'Smart summaries')).toBe(true);
    expect(of('billing', (e) => e.module === 'payments').every((s) => s === 'Payments')).toBe(true);
    expect(of('catalog', (e) => /price|surcharge|tax/.test(e.id) && e.id !== 'catalog.credit_parties').every((s) => s === 'Pricing')).toBe(true);
    // at least one entry of each family exists, so the assertions above are not vacuous
    for (const [g, m] of [['laboratory', 'lab'], ['laboratory', 'micro'], ['laboratory', 'anatomic'], ['reporting', 'smartreport'], ['billing', 'payments']] as const)
      expect(sorted(g).some((e) => e.module === m), `${g}/${m}`).toBe(true);
  });

  // "a section is one contiguous run" removed (ruling T0D-MSERIES-2): 13:69 wants sub-headings, not contiguous manifest `order`; the
  // once-per-heading render check lives in m2.sidebar.test.tsx.

  it('section keys are catalogued messages (never rendered as a raw key)', () => {
    for (const e of entries) if ((e as any).section) expect(t((e as any).section), `${e.id} section`).not.toBe((e as any).section);
  });
});
