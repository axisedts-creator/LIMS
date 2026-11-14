// Rail groups (10-DESIGN-SYSTEM §3, LD-140): "groups follow the work, not the database". Manifests keep their NavGroup;
// the shell folds the 14 NavGroups onto these 8 headings, in this order.
import type { NavGroup } from './types';

export const RAIL_GROUPS = [
  { id: 'front_desk', labelKey: 'core.nav.group.front_desk' },
  { id: 'lab', labelKey: 'core.nav.group.lab' },
  { id: 'reports', labelKey: 'core.nav.group.reports' },
  { id: 'accounts', labelKey: 'core.nav.group.accounts' },
  { id: 'catalog', labelKey: 'core.nav.group.catalog' },
  { id: 'instruments', labelKey: 'core.nav.group.instruments' },
  { id: 'people_access', labelKey: 'core.nav.group.people_access' },
  { id: 'settings', labelKey: 'core.nav.group.settings' },
] as const;
export type RailGroupId = (typeof RAIL_GROUPS)[number]['id'];

// [CONV] mapping of the non-namesake groups (spec names only the 8 headings).
const MAP: Record<NavGroup, RailGroupId> = {
  front_desk: 'front_desk', home_collection: 'front_desk', engagement: 'front_desk',
  laboratory: 'lab', quality: 'lab',
  reporting: 'reports', analytics: 'reports',
  billing: 'accounts', partners: 'accounts',
  catalog: 'catalog',
  instruments: 'instruments', inventory: 'instruments',
  admin: 'people_access',
  platform: 'settings',
};

export const railGroupFor = (group: NavGroup): RailGroupId => MAP[group] ?? 'settings';
