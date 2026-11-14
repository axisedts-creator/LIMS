// T0D-UI-R04: rail groups (10-DESIGN-SYSTEM §3): Front desk · Lab · Reports · Accounts · Catalog · Instruments · People & access · Settings.
// CONTRACT chosen by the tester: core/nav/rail-groups.ts exports
//   RAIL_GROUPS: readonly { id: string; labelKey: string }[]   (the eight, in this order; ids: front_desk lab reports accounts catalog instruments people_access settings)
//   railGroupFor(group: NavGroup): RailGroupId                  (total over NAV_GROUPS; build-nav.ts and every nav.manifest.ts keep their existing group values)
// Labels come from the message catalogue: t(labelKey) is the English heading.
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/messages.ts';
import { NAV_GROUPS } from '../types.ts';
import * as mod from '../rail-groups.ts';

const RAIL_GROUPS = mod.RAIL_GROUPS as readonly { id: string; labelKey: string }[];
const railGroupFor = mod.railGroupFor as (g: string) => string;

describe('RAIL_GROUPS', () => {
  it('are exactly the eight spec groups, in spec order', () => {
    expect(RAIL_GROUPS.map((g) => g.id)).toEqual(['front_desk', 'lab', 'reports', 'accounts', 'catalog', 'instruments', 'people_access', 'settings']);
    expect(RAIL_GROUPS.map((g) => t(g.labelKey))).toEqual(['Front desk', 'Lab', 'Reports', 'Accounts', 'Catalog', 'Instruments', 'People & access', 'Settings']);
  });
  it('label keys are unique and live in the core catalogue (never rendered as a raw key)', () => {
    const keys = RAIL_GROUPS.map((g) => g.labelKey);
    expect(new Set(keys).size).toBe(8);
    for (const k of keys) { expect(k).toMatch(/^core\.nav\./); expect(t(k)).not.toBe(k); }
  });
});

describe('railGroupFor', () => {
  it('is total: every NavGroup (all 14 today) lands in one of the eight', () => {
    const ids = new Set(RAIL_GROUPS.map((g) => g.id));
    for (const g of NAV_GROUPS) expect(ids.has(railGroupFor(g)), `${g} -> ${railGroupFor(g)}`).toBe(true);
  });
  it('maps the unambiguous groups to their namesake', () => {
    expect(railGroupFor('front_desk')).toBe('front_desk');
    expect(railGroupFor('laboratory')).toBe('lab');
    expect(railGroupFor('reporting')).toBe('reports');
    expect(railGroupFor('billing')).toBe('accounts');
    expect(railGroupFor('catalog')).toBe('catalog');
    expect(railGroupFor('instruments')).toBe('instruments');
    expect(railGroupFor('admin')).toBe('people_access');
    expect(railGroupFor('platform')).toBe('settings');
  });
  it('every one of the eight groups is reachable from some NavGroup (no dead heading)', () => {
    const used = new Set(NAV_GROUPS.map((g) => railGroupFor(g)));
    for (const g of RAIL_GROUPS) expect(used.has(g.id), g.id).toBe(true);
  });
});
