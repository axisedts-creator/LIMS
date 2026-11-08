// C3 04-UI-UX §1 (SCR-01…05). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// Entry ids / label keys are [CONV] (spec fixes only paths + permissions). SCR-01 also admits catalog.price_list.read in the page itself.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'catalog',
  entries: [
    { id: 'catalog.home', label: 'catalog.nav.home', routeId: 'staff.catalog.home', permission: 'catalog.test.read', group: 'catalog', order: 10 },
    { id: 'catalog.departments', label: 'catalog.nav.departments', routeId: 'staff.catalog.departments', permission: 'catalog.test.read', group: 'catalog', order: 20 },
    { id: 'catalog.specimens', label: 'catalog.nav.specimens', routeId: 'staff.catalog.specimens', permission: 'catalog.test.read', group: 'catalog', order: 30 },
    { id: 'catalog.methods', label: 'catalog.nav.methods', routeId: 'staff.catalog.methods', permission: 'catalog.test.read', group: 'catalog', order: 40 },
    { id: 'catalog.units', label: 'catalog.nav.units', routeId: 'staff.catalog.units', permission: 'catalog.test.read', group: 'catalog', order: 50 },
  ],
};
