import type { NavManifest } from '@/core/nav/types';
export const navManifest: NavManifest = {
  module: 'billing',
  entries: [
    { id: 'billing.daily_cash', label: 'billing.nav.daily_cash', routeId: 'staff.billing.daily_cash', permission: 'billing.cash_report.read', group: 'billing', order: 10, chord: 'g s' },
  ],
};
