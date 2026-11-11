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
    // SCR-09…12 (T-33): paths + permissions are spec-fixed (04-UI-UX §1, CR-C3-003); ids/labels/orders are [CONV].
    { id: 'catalog.panels', label: 'catalog.nav.panels', routeId: 'staff.catalog.panels', permission: 'catalog.test.read', group: 'catalog', order: 60 },
    { id: 'catalog.comment_codes', label: 'catalog.nav.comment_codes', routeId: 'staff.catalog.comment_codes', permission: 'catalog.test.read', group: 'catalog', order: 70 },
    { id: 'catalog.doctors', label: 'catalog.nav.doctors', routeId: 'staff.catalog.doctors', permission: 'catalog.referrer.read', group: 'catalog', order: 80 },
    { id: 'catalog.credit_parties', label: 'catalog.nav.credit_parties', routeId: 'staff.catalog.credit_parties', permission: 'catalog.price_list.read', group: 'catalog', order: 90 },
    // SCR-18 (T-35): path spec-fixed; permission = the API floor of every import/export operation (kind-dependent ones are checked in the page/BFF).
    { id: 'catalog.imports', label: 'catalog.nav.imports', routeId: 'staff.catalog.imports', permission: 'catalog.test.read', group: 'catalog', order: 140 },
    // SCR-13/15/16/17 (T-34): paths + permissions are spec-fixed (04-UI-UX §1); ids/labels/orders are [CONV]. SCR-13 detail reuses staff.catalog.price_list.
    { id: 'catalog.price_lists', label: 'catalog.nav.price_lists', routeId: 'staff.catalog.price_lists', permission: 'catalog.price_list.read', group: 'catalog', order: 100 },
    { id: 'catalog.price_simulator', label: 'catalog.nav.price_simulator', routeId: 'staff.catalog.price_simulator', permission: 'catalog.price_list.read', group: 'catalog', order: 110 },
    { id: 'catalog.surcharges', label: 'catalog.nav.surcharges', routeId: 'staff.catalog.surcharges', permission: 'catalog.price_list.read', group: 'catalog', order: 120 },
    { id: 'catalog.tax', label: 'catalog.nav.tax', routeId: 'staff.catalog.tax', permission: 'catalog.price_list.read', group: 'catalog', order: 130 },
  ],
};
