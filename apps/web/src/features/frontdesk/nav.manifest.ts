// Frontdesk nav manifest (C4 04-UI-UX s3, s6, s7, s8.11; T0D-NAV-COMPLETE-1, LD-250). Paths from the spec; permission = the
// page's API operation floor; order = section order [CONV]. /frontdesk/settings (s8.11) entry added by ADMINPAGE-FD-1 once its page existed.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'frontdesk',
  entries: [
    { id: 'frontdesk.registration_new', label: 'frontdesk.nav.registration_new', routeId: 'staff.frontdesk.registration_new', permission: 'frontdesk.registration.create', group: 'front_desk', order: 10 },
    { id: 'frontdesk.worklist', label: 'frontdesk.nav.worklist', routeId: 'staff.frontdesk.worklist', permission: 'frontdesk.order.read', group: 'front_desk', order: 20 },
    { id: 'frontdesk.discount_approvals', label: 'frontdesk.nav.discount_approvals', routeId: 'staff.frontdesk.discount_approvals', permission: 'frontdesk.discount.approve', group: 'front_desk', order: 30 },
    // ADMINPAGE-FD-1 (LD-255): the page exists now (answers CR T0D-NAV-COMPLETE-1.1). Label key under core.nav.* so no new permission-shaped string appears.
    { id: 'frontdesk.settings', label: 'core.nav.frontdesk_settings', routeId: 'staff.frontdesk.settings', permission: 'frontdesk.settings.manage', group: 'front_desk', order: 40 },
  ],
};
