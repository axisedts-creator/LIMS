// C8 04-UI-UX §1 (verbatim). Validated against contracts/routes.yaml by core/nav/build-nav.ts.
// [CONV] analytics.reports chord is `g r`, not the spec's `g m`: `g m` is owned by instruments.messages (§1: on conflict C8 picks another).
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'analytics',
  entries: [
    { id: 'analytics.dashboard', label: 'analytics.nav.dashboard', routeId: 'staff.analytics.dashboard', permission: 'analytics.dashboard.read', group: 'analytics', order: 10, icon: 'chart', chord: 'g o' },
    { id: 'analytics.reports', label: 'analytics.nav.reports', routeId: 'staff.analytics.reports', permission: 'analytics.dashboard.read', group: 'analytics', order: 20, icon: 'table', chord: 'g r' },
    { id: 'analytics.collections', label: 'analytics.nav.collections', routeId: 'staff.analytics.collections', permission: 'analytics.collections.read', group: 'analytics', order: 25, icon: 'table' },
    { id: 'analytics.referral', label: 'analytics.nav.referral', routeId: 'staff.analytics.referral_incentive', permission: 'analytics.referral_report.read', group: 'analytics', order: 30, icon: 'users' },
    { id: 'analytics.exports', label: 'analytics.nav.exports', routeId: 'staff.analytics.exports', permission: 'analytics.data.export', group: 'analytics', order: 40, icon: 'download' },
    { id: 'analytics.schedules', label: 'analytics.nav.schedules', routeId: 'staff.analytics.schedules', permission: 'analytics.schedule.manage', group: 'analytics', order: 50, icon: 'calendar' },
  ],
};
