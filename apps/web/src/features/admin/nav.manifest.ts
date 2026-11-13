// Tenant admin nav manifest (C2 04-UI-UX §1, group "Administration"). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// LD-113 (2026-11-11): exactly these 13 routeIds, ids admin.*, in this order, no chords (§3 keeps `n`/`/` page-local).
// ME-1 "My account" stays a manifest entry (LD-113); role_new / role detail are reached from the roles list, not the nav.
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'admin',
  entries: [
    { id: 'admin.me', label: 'admin.nav.me', routeId: 'staff.admin.me', permission: 'identity.self.manage', group: 'admin', order: 10 },
    { id: 'admin.users', label: 'admin.nav.users', routeId: 'staff.admin.users', permission: 'identity.user.read', group: 'admin', order: 20 },
    { id: 'admin.user_new', label: 'admin.nav.user_new', routeId: 'staff.admin.user_new', permission: 'identity.user.manage', group: 'admin', order: 30 },
    { id: 'admin.roles', label: 'admin.nav.roles', routeId: 'staff.admin.roles', permission: 'identity.user.read', group: 'admin', order: 40 },
    { id: 'admin.branches', label: 'admin.nav.branches', routeId: 'staff.admin.branches', permission: 'identity.user.read', group: 'admin', order: 50 },
    { id: 'admin.centres', label: 'admin.nav.centres', routeId: 'staff.admin.centres', permission: 'identity.centre.read', group: 'admin', order: 60 },
    { id: 'admin.settings', label: 'admin.nav.settings', routeId: 'staff.admin.settings', permission: 'identity.settings.manage', group: 'admin', order: 70 },
    { id: 'admin.sessions', label: 'admin.nav.sessions', routeId: 'staff.admin.sessions', permission: 'identity.session.revoke', group: 'admin', order: 80 },
    { id: 'admin.audit', label: 'admin.nav.audit', routeId: 'staff.admin.audit', permission: 'audit.log.read', group: 'admin', order: 90 },
    { id: 'admin.access_log', label: 'admin.nav.access_log', routeId: 'staff.admin.access_log', permission: 'audit.log.read', group: 'admin', order: 100 },
    { id: 'admin.exports', label: 'admin.nav.exports', routeId: 'staff.admin.exports', permission: 'audit.log.export', group: 'admin', order: 110 },
    { id: 'admin.support_access', label: 'admin.nav.support_access', routeId: 'staff.admin.support_access', permission: 'audit.log.read', group: 'admin', order: 120 },
    { id: 'admin.access_review', label: 'admin.nav.access_review', routeId: 'staff.admin.access_review', permission: 'identity.user.read', group: 'admin', order: 130 },
  ],
};
