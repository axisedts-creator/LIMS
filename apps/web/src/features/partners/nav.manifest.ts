// C13 04-UI-UX §1 (verbatim, CR-C13-008 route ids). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// Partner/manifest detail pages are not nav entries.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'partners',
  entries: [
    { id: 'partners.inbox', label: 'partners.nav.inbox', routeId: 'staff.partners.inbox', permission: 'partners.manifest.receive', group: 'partners', order: 10, icon: 'inbox', chord: 'g b' },
    { id: 'partners.pickups', label: 'partners.nav.pickups', routeId: 'staff.partners.pickups', permission: 'partners.pickup.manage', group: 'partners', order: 20, icon: 'truck' },
    { id: 'partners.list', label: 'partners.nav.list', routeId: 'staff.partners.list', permission: 'partners.partner.read', group: 'partners', order: 30, icon: 'building' },
    { id: 'partners.referrers', label: 'partners.nav.referrers', routeId: 'staff.partners.referrers', permission: 'partners.referrer.map', group: 'partners', order: 40, icon: 'users' },
    { id: 'partners.settings', label: 'partners.nav.settings', routeId: 'staff.partners.settings', permission: 'partners.partner.manage', group: 'partners', order: 50, icon: 'settings' },
    // T0D-SALES-1 (LD-321): ElabAssist sales screens, additive after the five 04-UI-UX §1 entries.
    { id: 'partners.sales_designations', label: 'partners.nav.sales_designations', routeId: 'staff.partners.sales_designations', permission: 'partners.sales.read', group: 'partners', order: 60, icon: 'list' },
    { id: 'partners.sales_representatives', label: 'partners.nav.sales_representatives', routeId: 'staff.partners.sales_representatives', permission: 'partners.sales.read', group: 'partners', order: 70, icon: 'users' },
    { id: 'partners.sales_clients', label: 'partners.nav.sales_clients', routeId: 'staff.partners.sales_clients', permission: 'partners.sales.read', group: 'partners', order: 80, icon: 'building' },
    { id: 'partners.sales_areas', label: 'partners.nav.sales_areas', routeId: 'staff.partners.sales_areas', permission: 'partners.sales.read', group: 'partners', order: 90, icon: 'map' },
    // T0D-PARTYSET-1 (LD-321): ElabAssist franchise approval queue and non compliance penalties, additive.
    { id: 'partners.onboarding', label: 'partners.nav.onboarding', routeId: 'staff.partners.onboarding', permission: 'partners.onboarding.decide', group: 'partners', order: 100, icon: 'check' },
    { id: 'partners.penalties', label: 'partners.nav.penalties', routeId: 'staff.partners.penalties', permission: 'partners.penalty.manage', group: 'partners', order: 110, icon: 'warning' },
    { id: 'partners.penalty_events', label: 'partners.nav.penalty_events', routeId: 'staff.partners.penalty_events', permission: 'partners.penalty.manage', group: 'partners', order: 120, icon: 'list' },
    // T0D-MSGDESK-1 (LD-321): ElabAssist Message To Laboratory, the lab side ticket inbox.
    { id: 'partners.tickets', label: 'partners.nav.tickets', routeId: 'staff.partners.tickets', permission: 'partners.ticket.read', group: 'partners', order: 130, icon: 'inbox' },
  ],
};
