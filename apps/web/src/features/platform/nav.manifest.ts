// Platform console nav manifest (04-UI-UX §1/§3), rendered only by app/(platform)/layout.tsx.
// Paths/permissions copied from the 04-UI-UX §1 route table. PL-3 and the dead-letter detail are reached from lists.
// LD-114: the seven staff.platform.* routeIds below are in contracts/routes.yaml (C0 route task).
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'platform',
  entries: [
    { id: 'platform.home', label: 'nav.platform.home', routeId: 'staff.platform.home', permission: 'platform.tenant.read', group: 'platform', order: 10 },
    { id: 'platform.tenants', label: 'nav.platform.tenants', routeId: 'staff.platform.tenants', permission: 'platform.tenant.read', group: 'platform', order: 20 },
    { id: 'platform.ird', label: 'nav.platform.ird', routeId: 'staff.platform.ird', permission: 'platform.tenant.read', group: 'platform', order: 30 },
    { id: 'platform.support_sessions', label: 'nav.platform.support_sessions', routeId: 'staff.platform.support_sessions', permission: 'platform.tenant.read', group: 'platform', order: 40 },
    { id: 'platform.dead_letters', label: 'nav.platform.dead_letters', routeId: 'staff.platform.dead_letters', permission: 'platform.dead_letter.manage', group: 'platform', order: 50 },
    { id: 'platform.staff', label: 'nav.platform.staff', routeId: 'staff.platform.staff', permission: 'platform.staff.manage', group: 'platform', order: 60 },
    { id: 'platform.auth_events', label: 'nav.platform.auth_events', routeId: 'staff.platform.auth_events', permission: 'platform.tenant.read', group: 'platform', order: 70 },
  ],
};

/** Path + visible label per entry (layout-local until build:nav knows the platform routes). */
export const platformLinks: Readonly<Record<string, { path: string; text: string }>> = {
  'platform.home': { path: '/platform', text: 'Home' },
  'platform.tenants': { path: '/platform/tenants', text: 'Tenants' },
  'platform.ird': { path: '/platform/ird', text: 'IRD annexes' },
  'platform.support_sessions': { path: '/platform/support-sessions', text: 'Support sessions' },
  'platform.dead_letters': { path: '/platform/dead-letters', text: 'Dead letters' },
  'platform.staff': { path: '/platform/staff', text: 'Platform staff' },
  'platform.auth_events': { path: '/platform/auth-events', text: 'Sign-in events' },
};
